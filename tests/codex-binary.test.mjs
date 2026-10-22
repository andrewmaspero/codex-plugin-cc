import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveCodexBinary } from "../plugins/codex/scripts/lib/codex-binary.mts";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mts";
import { upsertJob } from "../plugins/codex/scripts/lib/state.mts";
import { isProcessAlive } from "../plugins/codex/scripts/lib/process.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mts");

function readStarts(binDir) {
  const stateFile = path.join(binDir, "fake-codex-state.json");
  return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).appServerStarts ?? 0 : 0;
}

/** A fake "ChatGPT-bundled" codex outside PATH, plus a different fake codex on PATH. */
function makeBinaries() {
  const bundledDir = makeTempDir();
  installFakeCodex(bundledDir);
  const pathDir = makeTempDir();
  installFakeCodex(pathDir);
  const bundled = path.join(bundledDir, "codex");
  const env = { ...buildEnv(pathDir), CODEX_COMPANION_BUNDLED_CODEX: bundled };
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  delete env.CODEX_COMPANION_CODEX_BIN;
  return { bundledDir, pathDir, bundled, pathCodex: path.join(pathDir, "codex"), env };
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function runTask(repo, env, ...args) {
  const result = run("node", [SCRIPT, "task", "--json", ...args, "check the binary"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the ChatGPT-bundled codex is preferred over PATH", () => {
  const { bundled, env } = makeBinaries();
  assert.deepEqual(resolveCodexBinary({ env }), { command: bundled, source: "bundled", bundled: true });
});

test("PATH codex is used when no bundled codex exists, and computer use then fails before launch", () => {
  const { pathCodex, env } = makeBinaries();
  const noBundle = { ...env, CODEX_COMPANION_BUNDLED_CODEX: "" };
  assert.deepEqual(resolveCodexBinary({ env: noBundle }), { command: pathCodex, source: "path", bundled: false });
  assert.throws(() => resolveCodexBinary({ env: noBundle, computerUse: true }), /Computer use needs the signed Codex bundled with the ChatGPT desktop app/);
});

test("CODEX_COMPANION_CODEX_BIN overrides the choice", () => {
  const { pathCodex, env } = makeBinaries();
  assert.deepEqual(resolveCodexBinary({ env: { ...env, CODEX_COMPANION_CODEX_BIN: "path" } }), { command: pathCodex, source: "path", bundled: false });
  assert.throws(
    () => resolveCodexBinary({ env: { ...env, CODEX_COMPANION_CODEX_BIN: "path" }, computerUse: true }),
    /CODEX_COMPANION_CODEX_BIN=path forces the PATH codex/
  );
  assert.deepEqual(resolveCodexBinary({ env: { ...env, CODEX_COMPANION_CODEX_BIN: "/opt/codex/bin/codex" } }), {
    command: "/opt/codex/bin/codex",
    source: "override",
    bundled: false
  });
  assert.throws(() => resolveCodexBinary({ env: { ...env, CODEX_COMPANION_CODEX_BIN: "codex" } }), /must be an absolute path/);
});

test("task --computer-use fails with an actionable error when the bundled codex is missing", () => {
  const { env } = makeBinaries();
  const repo = makeRepo();
  const result = run("node", [SCRIPT, "task", "--computer-use", "--background", "take a screenshot"], {
    cwd: repo,
    env: { ...env, CODEX_COMPANION_BUNDLED_CODEX: "" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Computer use needs the signed Codex bundled with the ChatGPT desktop app/);
});

test("tasks and the shared broker run the bundled codex, and setup reports the choice", () => {
  const { bundledDir, pathDir, bundled, env } = makeBinaries();
  const repo = makeRepo();

  const payload = runTask(repo, env, "--computer-use");
  assert.equal(payload.status, 0);
  assert.ok(readStarts(bundledDir) >= 1);
  assert.equal(readStarts(pathDir), 0);
  assert.equal(loadBrokerSession(repo)?.codexBinary, bundled);

  const setup = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.deepEqual(report.codexBinary, { command: bundled, source: "bundled", bundled: true });
  assert.equal(report.computerUse.available, false, "a fake bundle has no signed CodexCLI.app");
  assert.match(report.pathCodex.resolvedPath, new RegExp(pathDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("an idle shared broker on another binary is replaced", () => {
  const { bundledDir, pathCodex, bundled, env } = makeBinaries();
  const repo = makeRepo();

  runTask(repo, { ...env, CODEX_COMPANION_CODEX_BIN: "path" });
  const before = loadBrokerSession(repo);
  assert.equal(before?.codexBinary, pathCodex);

  runTask(repo, env);
  const after = loadBrokerSession(repo);
  assert.equal(after?.codexBinary, bundled);
  assert.notEqual(after?.endpoint, before?.endpoint);
  assert.ok(readStarts(bundledDir) >= 1);
});

test("a busy shared broker on another binary is left alone and the job gets a dedicated broker", async () => {
  const { bundledDir, pathCodex, env } = makeBinaries();
  const repo = makeRepo();

  runTask(repo, { ...env, CODEX_COMPANION_CODEX_BIN: "path" });
  const shared = loadBrokerSession(repo);
  assert.equal(shared?.codexBinary, pathCodex);

  // Another workspace job is live on the shared broker.
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    upsertJob(repo, {
      id: "task-live-other",
      kind: "task",
      status: "running",
      pid: sleeper.pid,
      workspaceRoot: repo,
      runCwd: repo,
      brokerEndpoint: shared.endpoint,
      brokerTransport: "shared"
    });

    const payload = runTask(repo, env);
    assert.equal(payload.status, 0);
    assert.ok(readStarts(bundledDir) >= 1, "the job ran on the bundled codex");
    assert.deepEqual(loadBrokerSession(repo), shared, "the shared broker was not replaced");
    assert.equal(isProcessAlive(shared.pid), true, "the shared broker was not killed");
  } finally {
    sleeper.kill("SIGKILL");
  }
});
