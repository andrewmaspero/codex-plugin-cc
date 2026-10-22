import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveBinaryPath, runCommand } from "./process.mts";

/**
 * Which `codex` executable every runtime (broker, direct app-server, probes)
 * spawns. Computer use only works from the OpenAI-signed Codex bundled in the
 * ChatGPT desktop app: the Sky Computer Use helper checks the calling binary's
 * code signature, and an npm/pnpm/vite-plus install fails with
 * "Sky Computer Use native pipe startup failed". So the bundled binary is the
 * default whenever it exists, and PATH `codex` is the fallback.
 *
 *   CODEX_COMPANION_CODEX_BIN=<absolute path>  use exactly that binary
 *   CODEX_COMPANION_CODEX_BIN=path             use PATH `codex` (no computer use)
 *   CODEX_COMPANION_CODEX_BIN=bundled          require the ChatGPT-bundled binary
 *   CODEX_COMPANION_BUNDLED_CODEX=<path>       where the bundled binary lives
 *                                              (default: ChatGPT.app in /Applications
 *                                              or ~/Applications)
 */
export const CODEX_BIN_ENV = "CODEX_COMPANION_CODEX_BIN";
export const BUNDLED_CODEX_ENV = "CODEX_COMPANION_BUNDLED_CODEX";

const BUNDLED_RELATIVE_PATH = path.join("ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
const BUNDLED_APP_RELATIVE_PATH = path.join("ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app");
const COMPUTER_USE_HELPER_PATH = path.join(".codex", "computer-use", "Codex Computer Use.app");

export type CodexBinarySource = "override" | "bundled" | "path";

export interface CodexBinary {
  /** The command to spawn: an absolute path, or "codex" when PATH has none (spawn then reports ENOENT). */
  command: string;
  source: CodexBinarySource;
  /** True when this is the ChatGPT-bundled, OpenAI-signed binary that computer use needs. */
  bundled: boolean;
}

export interface ResolveCodexBinaryOptions {
  env?: NodeJS.ProcessEnv;
  /** Fail unless the selected binary can run Codex computer use. */
  computerUse?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export class CodexBinaryError extends Error {
  code = "ECODEXBINARY";
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function bundledCodexCandidates(options: ResolveCodexBinaryOptions = {}): string[] {
  const env = options.env ?? process.env;
  const configured = env[BUNDLED_CODEX_ENV];
  if (configured != null) {
    // An explicit (even empty) setting replaces the defaults, so tests and
    // unusual installs never fall through to /Applications.
    return configured ? [configured] : [];
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    return [];
  }
  return [
    path.join("/Applications", BUNDLED_RELATIVE_PATH),
    path.join(options.homeDir ?? os.homedir(), "Applications", BUNDLED_RELATIVE_PATH)
  ];
}

export function findBundledCodex(options: ResolveCodexBinaryOptions = {}): string | null {
  return bundledCodexCandidates(options).find(isExecutable) ?? null;
}

function bundledRequiredError(options: ResolveCodexBinaryOptions, reason: string): CodexBinaryError {
  const looked = bundledCodexCandidates(options);
  return new CodexBinaryError(
    `${reason} needs the signed Codex bundled with the ChatGPT desktop app, which was not found` +
      (looked.length ? ` (looked in ${looked.join(", ")})` : "") +
      `. Install or update the ChatGPT app, or set ${BUNDLED_CODEX_ENV} to its codex-cli/bin/codex.`
  );
}

export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): CodexBinary {
  const env = options.env ?? process.env;
  const override = env[CODEX_BIN_ENV]?.trim() ?? "";
  const bundledCandidates = bundledCodexCandidates(options);

  if (override && override !== "path" && override !== "bundled" && override !== "auto") {
    if (!path.isAbsolute(override)) {
      throw new CodexBinaryError(`${CODEX_BIN_ENV} must be an absolute path, "path", "bundled", or "auto"; got ${JSON.stringify(override)}.`);
    }
    return { command: override, source: "override", bundled: bundledCandidates.includes(override) };
  }

  if (override === "path") {
    if (options.computerUse) {
      throw new CodexBinaryError(
        `Computer use needs the signed ChatGPT-bundled Codex, but ${CODEX_BIN_ENV}=path forces the PATH codex. Unset it for this job.`
      );
    }
    return { command: resolveBinaryPath("codex", env) ?? "codex", source: "path", bundled: false };
  }

  const bundled = findBundledCodex(options);
  if (bundled) {
    return { command: bundled, source: "bundled", bundled: true };
  }
  if (override === "bundled") {
    throw bundledRequiredError(options, `${CODEX_BIN_ENV}=bundled`);
  }
  if (options.computerUse) {
    throw bundledRequiredError(options, "Computer use");
  }
  return { command: resolveBinaryPath("codex", env) ?? "codex", source: "path", bundled: false };
}

export interface ComputerUseStatus {
  available: boolean;
  detail: string;
}

function teamIdentifier(bundlePath: string): string | null {
  const result = runCommand("codesign", ["-dv", bundlePath], { stdio: ["ignore", "pipe", "pipe"] });
  const match = /TeamIdentifier=(\S+)/.exec(`${result.stderr}\n${result.stdout}`);
  return match && match[1] !== "not" ? match[1] : null;
}

/**
 * Cheap, static readiness check for Codex computer use: the selected binary is
 * the bundled one, its app bundle passes `codesign --verify`, and the computer
 * use helper is installed and signed by the same team. It does not start a
 * session, so macOS privacy grants and the helper's own runtime are unproven.
 */
export function getComputerUseStatus(binary: CodexBinary, options: ResolveCodexBinaryOptions = {}): ComputerUseStatus {
  if ((options.platform ?? process.platform) !== "darwin") {
    return { available: false, detail: "computer use is macOS-only" };
  }
  if (!binary.bundled) {
    const bundled = findBundledCodex(options);
    return {
      available: false,
      detail: bundled
        ? `unavailable with ${binary.command}; the signed ChatGPT-bundled Codex at ${bundled} is needed (unset ${CODEX_BIN_ENV})`
        : "unavailable: the ChatGPT desktop app's bundled Codex was not found"
    };
  }
  const appBundle = path.resolve(path.dirname(binary.command), "..", "CodexCLI.app");
  const appPath = fs.existsSync(appBundle) ? appBundle : null;
  if (!appPath) {
    return { available: false, detail: `bundled launcher found but ${BUNDLED_APP_RELATIVE_PATH} is missing next to it` };
  }
  const verify = runCommand("codesign", ["--verify", "--strict", appPath], { stdio: ["ignore", "pipe", "pipe"] });
  if (verify.error || verify.status !== 0) {
    return { available: false, detail: `bundled Codex failed codesign --verify: ${(verify.stderr || verify.error?.message || "").trim().split(/\r?\n/, 1)[0]}` };
  }
  const helper = path.join(options.homeDir ?? os.homedir(), COMPUTER_USE_HELPER_PATH);
  if (!fs.existsSync(helper)) {
    return { available: false, detail: `bundled Codex is signed, but the computer use helper is not installed at ${helper}; enable Computer Use in the ChatGPT app once` };
  }
  const codexTeam = teamIdentifier(appPath);
  const helperTeam = teamIdentifier(helper);
  if (!codexTeam || codexTeam !== helperTeam) {
    return { available: false, detail: `bundled Codex team ${codexTeam ?? "unknown"} does not match the computer use helper team ${helperTeam ?? "unknown"}` };
  }
  return {
    available: true,
    detail: `likely available: signed bundled Codex and helper share team ${codexTeam} (not a live session check)`
  };
}
