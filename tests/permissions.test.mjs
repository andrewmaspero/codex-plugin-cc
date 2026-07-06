import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mts");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mts");

function cleanEnv(binDir) {
  const env = buildEnv(binDir);
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.CODEX_COMPANION_TRANSCRIPT_PATH;
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  delete env.CLAUDE_PLUGIN_DATA;
  return env;
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function endSession(cwd, env) {
  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}

test("task --full runs with danger-full-access and --write with workspace-write", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  let result = run("node", [SCRIPT, "task", "--json", "--full", "inspect and fix everything"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sandbox, "danger-full-access");
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "danger-full-access");

  result = run("node", [SCRIPT, "task", "--json", "--write", "apply the fix"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "workspace-write");
  endSession(repo, env);
});

test("setup --sandbox full sets a workspace default that tasks inherit and flags override", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const setup = run("node", [SCRIPT, "setup", "--json", "--sandbox", "full"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.defaultSandbox, "danger-full-access");
  assert.match(setupPayload.actionsTaken.join(" "), /danger-full-access/);

  let result = run("node", [SCRIPT, "task", "--json", "no flags at all"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "danger-full-access");

  result = run("node", [SCRIPT, "task", "--json", "--sandbox", "read-only", "safe investigation"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "read-only");

  const cleared = run("node", [SCRIPT, "setup", "--json", "--sandbox", "clear"], { cwd: repo, env });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).defaultSandbox, "read-only");
  endSession(repo, env);
});

test("task rejects unknown sandbox modes", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--json", "--sandbox", "yolo", "do things"], { cwd: repo, env: cleanEnv(binDir) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported sandbox mode "yolo"/);
});

test("task --worktree isolates the job in a codex worktree with runCwd tracking", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const worktreeRoot = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...cleanEnv(binDir), CODEX_COMPANION_WORKTREE_ROOT: worktreeRoot };

  const result = run(
    "node",
    [SCRIPT, "task", "--json", "--full", "--worktree-name", "wt-test", "implement the feature in isolation"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  const expectedPath = path.join(worktreeRoot, "cc-wt-test", path.basename(repo));
  assert.equal(payload.worktree.worktreePath, expectedPath);
  assert.equal(payload.worktree.branch, "codex/wt-test");
  assert.ok(fs.existsSync(path.join(expectedPath, "README.md")), "worktree checkout should exist");

  const worktreeList = run("git", ["worktree", "list"], { cwd: repo });
  assert.match(worktreeList.stdout, /cc-wt-test/);

  const fakeState = readFakeState(binDir);
  assert.equal(fs.realpathSync(fakeState.lastThreadStart.cwd), fs.realpathSync(expectedPath));
  assert.equal(fakeState.lastThreadStart.sandbox, "danger-full-access");

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const job = state.jobs[0];
  assert.equal(job.runCwd, expectedPath);
  assert.equal(job.worktree.branch, "codex/wt-test");

  endSession(expectedPath, env);
  endSession(repo, env);
});

test("worktree creation refuses a name that already exists", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const worktreeRoot = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...cleanEnv(binDir), CODEX_COMPANION_WORKTREE_ROOT: worktreeRoot };

  fs.mkdirSync(path.join(worktreeRoot, "cc-dupe", path.basename(repo)), { recursive: true });
  const result = run("node", [SCRIPT, "task", "--json", "--worktree-name", "dupe", "some work"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Worktree path already exists/);
});
