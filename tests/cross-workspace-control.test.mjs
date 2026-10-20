import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mts";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mts";

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

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) {
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

function readJobs(repo) {
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  if (!fs.existsSync(stateFile)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
}

function readFakeState(binDir) {
  const file = path.join(binDir, "fake-codex-state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { appServerStarts: 0 };
}

function endSession(cwd, env) {
  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}

// Regression for the 2026-10-20 defect: steer and cancel run from a different
// workspace than the job's fell back to the per-job file (which never records
// the broker endpoint), connected with the caller's cwd, found no broker there,
// and spawned a fresh direct app-server that answered "thread not found".
test("steer and cancel from another workspace reach the job's own broker", async () => {
  const jobRepo = makeRepo();
  const callerRepo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);
  env.FAKE_CODEX_HOLD_TURNS = "1";

  const launch = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky login test"], {
    cwd: jobRepo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  try {
    const running = await waitFor(() => {
      const job = readJobs(jobRepo).find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId && job.turnId && job.brokerEndpoint ? job : null;
    });
    const startsBefore = readFakeState(binDir).appServerStarts;

    const steer = run(
      "node",
      [SCRIPT, "steer", jobId, "--json", "--", "Focus only on the login timeout."],
      { cwd: callerRepo, env }
    );
    assert.equal(steer.status, 0, steer.stderr);
    const steerPayload = JSON.parse(steer.stdout);
    assert.equal(steerPayload.steered, true, steerPayload.detail);
    assert.equal(steerPayload.transport, "broker");
    assert.deepEqual(readFakeState(binDir).lastSteer, {
      threadId: running.threadId,
      expectedTurnId: running.turnId,
      text: "Focus only on the login timeout."
    });

    const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: callerRepo, env });
    assert.equal(cancel.status, 0, cancel.stderr);
    const cancelPayload = JSON.parse(cancel.stdout);
    assert.equal(cancelPayload.turnInterrupted, true, cancelPayload.turnInterruptDetail);
    assert.equal(readFakeState(binDir).lastInterrupt?.threadId, running.threadId);

    // Neither command started a runtime of its own or a broker for the caller.
    assert.equal(readFakeState(binDir).appServerStarts, startsBefore);
    assert.equal(loadBrokerSession(callerRepo), null);
    assert.equal(readJobs(jobRepo).find((candidate) => candidate.id === jobId)?.status, "cancelled");
  } finally {
    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: jobRepo, env });
    endSession(jobRepo, env);
  }
});

test("steer and cancel report unreachable and spawn nothing when the job's workspace has no broker", () => {
  const jobRepo = makeRepo();
  const callerRepo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);

  // Unique: the global lookup scans every workspace state dir under the
  // shared test state root, including earlier runs'.
  const jobId = `task-nobroker-${path.basename(jobRepo)}`;
  const record = {
    id: jobId,
    status: "running",
    jobClass: "task",
    title: "Codex Task",
    workspaceRoot: jobRepo,
    threadId: "thr_orphan",
    turnId: "turn_orphan",
    pid: null,
    startedAt: new Date().toISOString()
  };
  upsertJob(jobRepo, record);
  writeJobFile(jobRepo, jobId, record);

  const steer = run("node", [SCRIPT, "steer", jobId, "--json", "--", "change direction"], { cwd: callerRepo, env });
  assert.equal(steer.status, 1, steer.stderr);
  assert.ok(steer.stdout, steer.stderr);
  const steerPayload = JSON.parse(steer.stdout);
  assert.equal(steerPayload.steered, false);
  assert.equal(steerPayload.failureKind, "unreachable");
  assert.match(steerPayload.detail, /unreachable: no broker for this job's workspace/);
  assert.doesNotMatch(steerPayload.detail, /thread not found/);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: callerRepo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.turnInterrupted, false);
  assert.match(cancelPayload.turnInterruptDetail, /unreachable: no broker for this job's workspace/);

  assert.equal(readFakeState(binDir).appServerStarts, 0, "no app-server may be spawned");
  assert.equal(loadBrokerSession(jobRepo), null);
  assert.equal(loadBrokerSession(callerRepo), null);
});
