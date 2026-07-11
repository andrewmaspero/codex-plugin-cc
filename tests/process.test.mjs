import { test } from "vitest";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { getCodexAvailability } from "../plugins/codex/scripts/lib/codex.mts";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mts";
import { cleanupTestProcesses, makeTempDir, writeExecutable } from "./helpers.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("Codex availability reports an entirely absent binary with neutral install hints", () => {
  const previousPath = process.env.PATH;
  process.env.PATH = makeTempDir();
  try {
    const availability = getCodexAvailability(process.cwd());
    assert.equal(availability.available, false);
    assert.match(availability.detail, /not found on PATH/i);
    assert.match(availability.detail, /npm i -g @openai\/codex/);
    assert.match(availability.detail, /pnpm add -g @openai\/codex/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("Codex availability identifies a wrapper shim that exits nonzero", () => {
  const binDir = makeTempDir();
  const codexPath = path.join(binDir, "codex");
  writeExecutable(codexPath, "#!/bin/sh\necho 'dense proxy could not find codex' >&2\nexit 42\n");
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const availability = getCodexAvailability(process.cwd());
    assert.equal(availability.available, false);
    assert.match(availability.detail, new RegExp(codexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(availability.detail, /dense proxy could not find codex/);
    assert.doesNotMatch(availability.detail, /second diagnostic line/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("Codex availability reports a missing app-server subcommand with the resolved binary", () => {
  const binDir = makeTempDir();
  const codexPath = path.join(binDir, "codex");
  writeExecutable(
    codexPath,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli test'; exit 0; fi\necho 'unknown subcommand app-server' >&2\nexit 2\n"
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const availability = getCodexAvailability(process.cwd());
    assert.equal(availability.available, false);
    assert.match(availability.detail, /advanced runtime unavailable/i);
    assert.match(availability.detail, new RegExp(codexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(availability.detail, /unknown subcommand app-server/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("test process cleanup reaps detached children tied to fixture temp directories", async () => {
  const tempDir = makeTempDir("codex-plugin-cleanup-test-");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", tempDir], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  assert.ok(child.pid);

  cleanupTestProcesses();

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(child.pid, 0));
  assert.ok(fs.existsSync(tempDir));
});
