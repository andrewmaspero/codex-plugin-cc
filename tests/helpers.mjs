import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const createdTempDirs = [];
let leakCleanupRegistered = false;

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  registerLeakedProcessCleanup();
  return dir;
}

// Companion commands under test auto-start detached brokers and fake
// app-servers whose argv references the test temp dir; without this sweep they
// outlive the test run (observed 1300+ accumulated zombies). Matching on the
// unique mkdtemp path — never a name pattern — so a sibling agent's live run
// on a shared machine cannot be killed.
function registerLeakedProcessCleanup() {
  if (leakCleanupRegistered || process.platform === "win32") {
    return;
  }
  leakCleanupRegistered = true;
  process.on("exit", () => {
    for (const dir of createdTempDirs) {
      spawnSync("pkill", ["-f", dir], { encoding: "utf8" });
    }
  });
}

// A test run started from inside a Claude Code session inherits
// CLAUDE_PLUGIN_DATA (redirects companion state out of the fixture tmp dirs)
// and CODEX_COMPANION_SESSION_ID (session-scopes job visibility), which break
// fixture assertions. Scrub them once per test process, at import time, so
// in-process state-path computations and spawned companions agree.
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;

export function testBaseEnv() {
  return { ...process.env };
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
