// Turn-completion reconciliation layers for alive-but-hung workers
// (2026-07-06-worker-misses-turn-completion.md):
// 1. worker-side: captureTurn polls the thread's latest turn when the event
//    stream goes silent and synthesizes the completion;
// 2. read-side: status/alerts finalize running jobs whose thread already has
//    a terminal latest turn (`completed-but-unreconciled`);
// 3. codex-side: the notify hook (turn-complete-hook.mts) finalizes jobs when
//    codex itself reports the turn finished and the worker never did.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mts");
const HOOK_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "turn-complete-hook.mts");
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

function readJobs(repo) {
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  if (!fs.existsSync(stateFile)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
}

async function waitFor(predicate, { timeoutMs = 90000, intervalMs = 50 } = {}) {
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

function endSession(cwd, env) {
  run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
  });
}

function killPid(pid) {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("worker reconciles a silently completed turn from thread state", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "no-turn-events");
  const env = cleanEnv(binDir);
  env.CODEX_COMPANION_IDLE_RECONCILE_MS = "500";

  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "silent turn"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;

    const done = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    });

    assert.equal(done.status, "completed", `job should complete via reconciliation: ${JSON.stringify(done)}`);
    const log = fs.readFileSync(done.logFile, "utf8");
    assert.match(log, /Turn completion reconciled from thread state/, "log has no reconciliation line");

    const result = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      String(JSON.parse(result.stdout).storedJob?.result?.rawOutput ?? ""),
      /Handled the requested task/,
      "reconciled result did not capture the turn's final agent message"
    );
  } finally {
    endSession(repo, env);
  }
});

test("status and alerts finalize a hung job whose turn already completed (completed-but-unreconciled)", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "no-turn-events");
  const env = cleanEnv(binDir);
  // Worker-side reconciliation off: the worker hangs forever, like the field
  // case where the event stream dropped and the pid stayed alive.
  env.CODEX_COMPANION_IDLE_RECONCILE_MS = "0";
  env.CODEX_COMPANION_RECONCILE_QUIET_MS = "400";

  let workerPid = null;
  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "hung worker turn"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;

    // Wait until the worker is wedged: thread recorded, still running.
    const running = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId ? job : null;
    });
    workerPid = running.pid;

    // Let the job log go quiet past the reconcile threshold.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const alerts = run("node", [SCRIPT, "alerts", jobId, "--json", "--no-goals"], { cwd: repo, env });
    assert.equal(alerts.status, 0, alerts.stderr);
    const payload = JSON.parse(alerts.stdout);
    const kinds = payload.alerts.map((alert) => alert.kind);
    assert.ok(
      kinds.includes("completed-but-unreconciled"),
      `expected completed-but-unreconciled alert, got: ${kinds.join(", ") || "none"}`
    );

    const job = readJobs(repo).find((candidate) => candidate.id === jobId);
    assert.equal(job.status, "completed", `job should be finalized inline: ${JSON.stringify(job)}`);
    assert.equal(job.reconciledBy, "read-reconciler");
    const log = fs.readFileSync(job.logFile, "utf8");
    assert.match(log, /finalized by read-side reconciliation/, "log has no read-reconciliation line");

    const result = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(String(JSON.parse(result.stdout).storedJob?.result?.rawOutput ?? ""), /Handled the requested task/);
  } finally {
    killPid(workerPid);
    endSession(repo, env);
  }
});

test("turn-complete hook finalizes a job the worker never closed, but leaves streaming jobs alone", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);
  env.CODEX_COMPANION_HOOK_GRACE_MS = "150";

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const makeHungJob = (id, threadId, logAgeMs) => {
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, `[${new Date(Date.now() - logAgeMs).toISOString()}] Thread ready (${threadId}).\n`, "utf8");
    const past = new Date(Date.now() - logAgeMs);
    fs.utimesSync(logFile, past, past);
    const job = {
      id,
      kind: "task",
      jobClass: "task",
      title: "Codex Task",
      status: "running",
      phase: "starting",
      pid: process.pid,
      threadId,
      workspaceRoot: repo,
      logFile,
      startedAt: past.toISOString()
    };
    return job;
  };

  const hungJob = makeHungJob("task-hook-hung", "thr_hook_1", 60000);
  upsertJob(repo, hungJob);
  writeJobFile(repo, hungJob.id, hungJob);

  const freshJob = makeHungJob("task-hook-fresh", "thr_hook_2", 60000);
  upsertJob(repo, freshJob);
  writeJobFile(repo, freshJob.id, freshJob);

  const payloadFor = (threadId) =>
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": threadId,
      "turn-id": "turn_hook",
      cwd: repo,
      "input-messages": ["do it"],
      "last-assistant-message": "All done via hook."
    });

  const hungRun = run("node", [HOOK_SCRIPT, payloadFor("thr_hook_1")], { cwd: repo, env });
  assert.equal(hungRun.status, 0, hungRun.stderr);

  // A live worker keeps appending log lines while the hook's grace window
  // runs; the hook must then leave the job alone.
  const freshHook = spawn("node", [HOOK_SCRIPT, payloadFor("thr_hook_2")], { cwd: repo, env });
  const appender = setInterval(() => {
    fs.appendFileSync(freshJob.logFile, `[${new Date().toISOString()}] Running command: npm test\n`);
  }, 40);
  const freshExit = await new Promise((resolve) => freshHook.on("close", resolve));
  clearInterval(appender);
  assert.equal(freshExit, 0);

  const jobs = readJobs(repo);
  const hungAfter = jobs.find((job) => job.id === "task-hook-hung");
  assert.equal(hungAfter.status, "completed", `hook should finalize the hung job: ${JSON.stringify(hungAfter)}`);
  assert.equal(hungAfter.reconciledBy, "codex-notify-hook");
  assert.match(fs.readFileSync(hungAfter.logFile, "utf8"), /recorded by the Codex notify hook/);

  const result = run("node", [SCRIPT, "result", "task-hook-hung", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(JSON.parse(result.stdout).storedJob?.result?.rawOutput ?? ""), /All done via hook/);

  const freshAfter = jobs.find((job) => job.id === "task-hook-fresh");
  assert.equal(freshAfter.status, "running", "hook must not finalize a job with fresh log activity");
});

test("spawned app-server is configured with the turn-complete notify hook", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  try {
    const task = run("node", [SCRIPT, "task", "--json", "check notify wiring"], { cwd: repo, env });
    assert.equal(task.status, 0, task.stderr);

    const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    const args = fakeState.lastAppServerArgs ?? [];
    const notifyArg = args.find((arg) => typeof arg === "string" && arg.startsWith("notify=["));
    assert.ok(notifyArg, `expected a notify override in app-server args, got: ${JSON.stringify(args)}`);
    assert.match(notifyArg, /turn-complete-hook\.mts/, "notify override does not point at the plugin hook script");
  } finally {
    endSession(repo, env);
  }
});
