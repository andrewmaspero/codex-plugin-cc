import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mts";
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

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("splitRawArgumentString passes prose after -- through verbatim", () => {
  const tokens = splitRawArgumentString(`task-1 --json -- don't touch C:\\repo, keep "the quoted part" as-is`);
  assert.deepEqual(tokens, ["task-1", "--json", "--", `don't touch C:\\repo, keep "the quoted part" as-is`]);
});

test("task --goal sets a native thread goal before the turn starts", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const result = run(
    "node",
    [SCRIPT, "task", "--json", "--goal", "Every page renders at 375px and 1440px with no console errors", "--goal-budget", "50000", "verify the UI"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);
  const taskPayload = JSON.parse(result.stdout);

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastGoalSet.threadId, taskPayload.threadId);
  assert.equal(fakeState.lastGoalSet.objective, "Every page renders at 375px and 1440px with no console errors");
  assert.equal(fakeState.lastGoalSet.tokenBudget, 50000);
  endSession(repo, env);
});

test("goal set/show/clear round-trips through a job reference", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const task = run("node", [SCRIPT, "task", "--json", "initial work"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const stateDir = resolveStateDir(repo);
  const jobId = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs[0].id;

  const set = run("node", [SCRIPT, "goal", "set", jobId, "--json", "--budget", "9000", "--", "Finish the migration; run npm test after every change"], {
    cwd: repo,
    env
  });
  assert.equal(set.status, 0, set.stderr);
  const setPayload = JSON.parse(set.stdout);
  assert.equal(setPayload.ok, true);
  assert.equal(setPayload.goal.tokenBudget, 9000);

  const show = run("node", [SCRIPT, "goal", "show", jobId, "--json"], { cwd: repo, env });
  assert.equal(show.status, 0, show.stderr);
  assert.match(JSON.parse(show.stdout).goal.objective, /Finish the migration/);

  const clear = run("node", [SCRIPT, "goal", "clear", jobId, "--json"], { cwd: repo, env });
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(JSON.parse(clear.stdout).cleared, true);

  const showAfter = run("node", [SCRIPT, "goal", "show", jobId, "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(showAfter.stdout).goal, null);
  endSession(repo, env);
});

test("goal set reaches an active brokered turn through the control bypass", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "long running investigation"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  try {
    const stateDir = resolveStateDir(repo);
    const runningJob = await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId ? job : null;
    });

    const set = run("node", [SCRIPT, "goal", "set", jobId, "--json", "--", "Stay focused on the timeout bug only"], { cwd: repo, env });
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).ok, true);
    // The fake codex writes its state file asynchronously to the RPC reply;
    // poll instead of asserting on a single read.
    await waitFor(() => {
      try {
        return readFakeState(binDir).lastGoalSet?.threadId === runningJob.threadId ? true : null;
      } catch {
        return null;
      }
    });

    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  } finally {
    endSession(repo, env);
  }
});

test("alerts reports goal drift for active jobs", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const task = run("node", [SCRIPT, "task", "--json", "goal drift target"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);

  const stateDir = resolveStateDir(repo);
  const stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const job = state.jobs[0];

  const set = run("node", [SCRIPT, "goal", "set", job.id, "--json", "--status", "blocked", "--", "Blocked goal for drift detection"], {
    cwd: repo,
    env
  });
  assert.equal(set.status, 0, set.stderr);

  // Re-mark the job as running so the alerts pass includes it in goal checks.
  job.status = "running";
  job.pid = process.pid;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const alerts = run("node", [SCRIPT, "alerts", "--json"], { cwd: repo, env });
  assert.equal(alerts.status, 0, alerts.stderr);
  const kinds = JSON.parse(alerts.stdout).alerts.map((alert) => alert.kind);
  assert.ok(kinds.includes("goal-blocked"), `expected goal-blocked alert, got ${kinds.join(", ")}`);
  endSession(repo, env);
});

test("turn pagination cursors survive the single-string slash-command argument path", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const first = run("node", [SCRIPT, "task", "--json", "first turn"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const threadId = JSON.parse(first.stdout).threadId;

  const second = run("node", [SCRIPT, "continue", threadId, "--json", "second turn"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);

  const page1 = run("node", [SCRIPT, "turns", threadId, "--limit", "1", "--json"], { cwd: repo, env });
  assert.equal(page1.status, 0, page1.stderr);
  const page1Payload = JSON.parse(page1.stdout);
  assert.equal(page1Payload.turns.length, 1);
  assert.ok(page1Payload.nextCursor, "expected a JSON pagination cursor");

  // Single raw string, exactly how "$ARGUMENTS" reaches the companion.
  const page2 = run("node", [SCRIPT, "turns", `${threadId} --limit 1 --json --cursor '${page1Payload.nextCursor}'`], {
    cwd: repo,
    env
  });
  assert.equal(page2.status, 0, page2.stderr);
  const page2Payload = JSON.parse(page2.stdout);
  assert.equal(page2Payload.turns.length, 1);
  assert.notEqual(page2Payload.turns[0].id, page1Payload.turns[0].id);
  endSession(repo, env);
});
