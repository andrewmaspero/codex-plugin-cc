import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir, upsertJob } from "../plugins/codex/scripts/lib/state.mts";

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

function runTaskForeground(repo, env, prompt) {
  const result = run("node", [SCRIPT, "task", "--json", prompt], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function endSession(repo, env) {
  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}

test("steer delivers a compact correction to the active brokered turn", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  assert.ok(jobId);

  try {
    const stateDir = resolveStateDir(repo);
    const runningJob = await waitFor(() => {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId && job.turnId ? job : null;
    });

    const steer = run(
      "node",
      [SCRIPT, "steer", jobId, "--json", "--", "Stop editing auth files. Only fix the failing dashboard test."],
      { cwd: repo, env }
    );
    assert.equal(steer.status, 0, steer.stderr);
    const payload = JSON.parse(steer.stdout);
    assert.equal(payload.steered, true);
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.threadId, runningJob.threadId);
    assert.equal(payload.expectedTurnId, runningJob.turnId);
    assert.equal(payload.transport, "broker");

    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.deepEqual(fakeState.lastSteer, {
      threadId: runningJob.threadId,
      expectedTurnId: runningJob.turnId,
      text: "Stop editing auth files. Only fix the failing dashboard test."
    });

    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  } finally {
    endSession(repo, env);
  }
});

test("steer rejects an empty message before touching any job", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "steer", "task-does-not-exist"], { cwd: repo, env: cleanEnv(binDir) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Steer message is empty/);
});

test("steer refuses a finished job and points at continue", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  runTaskForeground(repo, env, "quick investigation task");
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const finished = state.jobs.find((job) => job.status === "completed");
  assert.ok(finished);

  const result = run("node", [SCRIPT, "steer", finished.id, "--", "change direction"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no active turn to steer/);
  assert.match(result.stderr, /codex:continue/);
  endSession(repo, env);
});

test("steer rejects an over-limit message", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const longMessage = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const result = run("node", [SCRIPT, "steer", "task-x", "--", longMessage], { cwd: repo, env: cleanEnv(binDir) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too long/);
});

test("thread viewers return bounded compact output with budgets", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const longPrompt = `investigate ${"very ".repeat(150)}long prompt`;
  const task = runTaskForeground(repo, env, longPrompt);
  assert.ok(task.threadId);

  const threads = run("node", [SCRIPT, "threads", "--json", "--all"], { cwd: repo, env });
  assert.equal(threads.status, 0, threads.stderr);
  const threadsPayload = JSON.parse(threads.stdout);
  const listed = threadsPayload.threads.find((thread) => thread.id === task.threadId);
  assert.ok(listed, "expected the task thread to be listed");

  const single = run("node", [SCRIPT, "thread", task.threadId, "--json"], { cwd: repo, env });
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).id, task.threadId);

  const turns = run("node", [SCRIPT, "turns", task.threadId, "--json"], { cwd: repo, env });
  assert.equal(turns.status, 0, turns.stderr);
  const turnsPayload = JSON.parse(turns.stdout);
  assert.equal(turnsPayload.usedFallback, false);
  assert.equal(turnsPayload.turns.length, 1);
  const [turn] = turnsPayload.turns;
  assert.deepEqual(turn.itemCounts, { userMessage: 1, agentMessage: 1 });
  assert.ok(turn.userText.length <= 100, "turn user text must be compacted");

  const items = run("node", [SCRIPT, "items", task.threadId, "--json", "--type", "agentMessage"], { cwd: repo, env });
  assert.equal(items.status, 0, items.stderr);
  const itemsPayload = JSON.parse(items.stdout);
  assert.equal(itemsPayload.matchedTotal, 1);
  assert.equal(itemsPayload.items.length, 1);
  assert.equal(itemsPayload.items[0].type, "agentMessage");

  const budgeted = run("node", [SCRIPT, "items", task.threadId, "--json", "--budget", "500"], { cwd: repo, env });
  assert.equal(budgeted.status, 0, budgeted.stderr);
  const budgetedPayload = JSON.parse(budgeted.stdout);
  assert.equal(budgetedPayload.budgetTruncated, true);
  assert.ok(budgetedPayload.returned < budgetedPayload.matchedTotal);
  endSession(repo, env);
});

test("turn viewers fall back to thread/read on legacy Codex CLIs", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "legacy-thread-read");
  const env = cleanEnv(binDir);

  const task = runTaskForeground(repo, env, "legacy runtime task");
  const turns = run("node", [SCRIPT, "turns", task.threadId, "--json"], { cwd: repo, env });
  assert.equal(turns.status, 0, turns.stderr);
  const payload = JSON.parse(turns.stdout);
  assert.equal(payload.usedFallback, true);
  assert.equal(payload.turns.length, 1);
  assert.deepEqual(payload.turns[0].itemCounts, { userMessage: 1, agentMessage: 1 });
  endSession(repo, env);
});

test("tail returns the last bounded slice of a job log", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  runTaskForeground(repo, env, "quick investigation task");
  const tail = run("node", [SCRIPT, "tail", "--json", "--lines", "5"], { cwd: repo, env });
  assert.equal(tail.status, 0, tail.stderr);
  const payload = JSON.parse(tail.stdout);
  assert.ok(payload.jobId);
  assert.ok(payload.lines.length > 0);
  assert.ok(payload.lines.length <= 5);
  endSession(repo, env);
});

test("alerts flags stalled and failed jobs with suggested actions", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const staleLog = path.join(jobsDir, "stalled.log");
  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(staleLog, `[${staleTimestamp}] Running command: npm test\n`, "utf8");
  upsertJob(repo, {
    id: "task-stalled",
    status: "running",
    jobClass: "task",
    startedAt: staleTimestamp,
    logFile: staleLog
  });
  upsertJob(repo, {
    id: "task-broken",
    status: "failed",
    jobClass: "task",
    errorMessage: "authentication expired; run codex login"
  });

  const alerts = run("node", [SCRIPT, "alerts", "--json"], { cwd: repo, env });
  assert.equal(alerts.status, 0, alerts.stderr);
  const payload = JSON.parse(alerts.stdout);
  const kinds = payload.alerts.map((alert) => `${alert.jobId}:${alert.kind}`);
  assert.ok(kinds.includes("task-stalled:stalled"), `expected stalled alert, got ${kinds.join(", ")}`);
  assert.ok(kinds.includes("task-broken:failed"), `expected failed alert, got ${kinds.join(", ")}`);
  for (const alert of payload.alerts) {
    assert.ok(alert.evidence);
    assert.ok(alert.suggestedAction);
  }
});

test("continue starts a follow-up turn on an explicit existing thread", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const first = runTaskForeground(repo, env, "initial investigation");
  assert.ok(first.threadId);

  const followUp = run("node", [SCRIPT, "continue", first.threadId, "--json", "apply the recommended fix"], {
    cwd: repo,
    env
  });
  assert.equal(followUp.status, 0, followUp.stderr);
  const payload = JSON.parse(followUp.stdout);
  assert.equal(payload.status, 0);
  assert.equal(payload.threadId, first.threadId);

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const continueJob = state.jobs.find((job) => job.title === "Codex Continue");
  assert.ok(continueJob, "expected a tracked Codex Continue job");
  assert.equal(continueJob.threadId, first.threadId);
  endSession(repo, env);
});
