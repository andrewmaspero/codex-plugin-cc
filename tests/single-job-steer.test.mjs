import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mts";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mts";
import { classifySteerFailure } from "../plugins/codex/scripts/lib/codex.mts";
import { renderSteerResult } from "../plugins/codex/scripts/lib/control-plane.mts";

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

function endSession(cwd, env) {
  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}

// Regression for the live defect on 2026-07-14 (job task-mrkrnmbq-wfepjy): a
// SINGLE background job launched normally (no --worktree) must record the
// broker endpoint its turn actually streams through, and steer must resolve
// that endpoint from the job record and reach the active turn. The old failure
// mode blamed "several jobs share one workspace" for every steer failure.
test("a single background job without a worktree is steerable via its recorded endpoint", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);
  // Hold the turn open until interrupted so the steer below always races a
  // live turn (a fixed-length fake turn is flaky under load).
  env.FAKE_CODEX_HOLD_TURNS = "1";

  const launch = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky login test"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  try {
    const running = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId && job.turnId && job.brokerEndpoint ? job : null;
    });

    // The single normally-launched job runs on the workspace's shared broker
    // and its record must carry the endpoint the turn actually connected to.
    assert.equal(running.brokerTransport, "shared", `expected the shared broker, got ${running.brokerTransport}`);
    const session = loadBrokerSession(repo);
    assert.ok(session?.endpoint, "expected a broker session for the workspace");
    assert.equal(running.brokerEndpoint, session.endpoint, "job record must carry the actual runtime endpoint");

    const steer = run(
      "node",
      [SCRIPT, "steer", jobId, "--json", "--", "Focus only on the login timeout, skip the fixture rewrite."],
      { cwd: repo, env }
    );
    assert.equal(steer.status, 0, steer.stderr);
    const payload = JSON.parse(steer.stdout);
    assert.equal(payload.steered, true, payload.detail);
    assert.equal(payload.expectedTurnId, running.turnId);
    assert.equal(payload.activeJobCount, 1);
  } finally {
    run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
    endSession(repo, env);
  }
});

test("steer failure classification names the actual cause", () => {
  assert.equal(
    classifySteerFailure(new Error("thread not found: 019f611a-0dc9-7582-89bd-5d9850aee24d")),
    "threadNotFound"
  );
  assert.equal(classifySteerFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "unreachable");
  assert.equal(classifySteerFailure(Object.assign(new Error("busy"), { rpcCode: -32001 })), "busy");
  assert.equal(classifySteerFailure(new Error("something else")), "other");
});

test("steer failure message reports the real reason instead of blaming workspace sharing", () => {
  const base = {
    jobId: "task-test",
    jobStatus: "running",
    threadId: "019f611a-0dc9-7582-89bd-5d9850aee24d",
    expectedTurnId: "84cfec0d",
    steered: false,
    transport: "broker",
    detail: "thread not found: 019f611a-0dc9-7582-89bd-5d9850aee24d",
    softLimitExceeded: false
  };

  // The live-defect shape: single active job, runtime reachable, thread
  // re-keyed by in-turn auto-compaction. Must NOT claim multi-job contention
  // and must point at the cancel + continue recovery that actually works.
  const compacted = renderSteerResult({ ...base, failureKind: "threadNotFound", activeJobCount: 1 });
  assert.ok(!compacted.includes("several jobs share one workspace"), compacted);
  assert.ok(compacted.includes("auto-compaction"), compacted);
  assert.ok(compacted.includes(`/codex:continue ${base.threadId}`), compacted);

  // A genuinely unreachable runtime with one active job must not recommend
  // worktrees for a contention problem that does not exist.
  const unreachableSingle = renderSteerResult({ ...base, failureKind: "unreachable", activeJobCount: 1 });
  assert.ok(!unreachableSingle.includes("several jobs share one workspace"), unreachableSingle);
  assert.ok(!unreachableSingle.includes("--worktree"), unreachableSingle);

  // Only a real multi-job workspace earns the worktree advice.
  const unreachableParallel = renderSteerResult({ ...base, failureKind: "unreachable", activeJobCount: 3 });
  assert.ok(unreachableParallel.includes("--worktree"), unreachableParallel);
});
