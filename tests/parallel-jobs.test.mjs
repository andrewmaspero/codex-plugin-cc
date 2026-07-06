import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mts";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mts";

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

function endpointReachable(endpoint) {
  return new Promise((resolve) => {
    let target;
    try {
      target = parseBrokerEndpoint(endpoint);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ path: target.path });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

test("two parallel jobs in one workspace are both steerable", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);

  const first = run("node", [SCRIPT, "task", "--background", "--json", "investigate the first failure"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstId = JSON.parse(first.stdout).jobId;

  try {
    const firstRunning = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === firstId);
      return job?.status === "running" && job.threadId && job.turnId ? job : null;
    });

    const second = run("node", [SCRIPT, "task", "--background", "--json", "investigate the second failure"], { cwd: repo, env });
    assert.equal(second.status, 0, second.stderr);
    const secondId = JSON.parse(second.stdout).jobId;

    const secondRunning = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === secondId);
      return job?.status === "running" && job.threadId && job.turnId && job.brokerEndpoint ? job : null;
    });

    // Job 1 owns the shared broker; job 2 must have received a dedicated one.
    assert.equal(secondRunning.brokerTransport, "dedicated", `expected a dedicated broker, got ${secondRunning.brokerTransport}`);
    assert.notEqual(secondRunning.brokerEndpoint, firstRunning.brokerEndpoint ?? null);

    const steerSecond = run(
      "node",
      [SCRIPT, "steer", secondId, "--json", "--", "Focus only on the worker timeout in the second module."],
      { cwd: repo, env }
    );
    assert.equal(steerSecond.status, 0, steerSecond.stderr);
    const secondPayload = JSON.parse(steerSecond.stdout);
    assert.equal(secondPayload.steered, true, secondPayload.detail);
    assert.equal(secondPayload.expectedTurnId, secondRunning.turnId);

    const steerFirst = run(
      "node",
      [SCRIPT, "steer", firstId, "--json", "--", "Stay on the first module only."],
      { cwd: repo, env }
    );
    assert.equal(steerFirst.status, 0, steerFirst.stderr);
    const firstPayload = JSON.parse(steerFirst.stdout);
    assert.equal(firstPayload.steered, true, firstPayload.detail);
    assert.equal(firstPayload.expectedTurnId, firstRunning.turnId);

    // Goals reach the dedicated-broker job too.
    const goal = run("node", [SCRIPT, "goal", "set", secondId, "--json", "--", "Fix the second failure end to end"], {
      cwd: repo,
      env
    });
    assert.equal(goal.status, 0, goal.stderr);
    assert.equal(JSON.parse(goal.stdout).ok, true);

    // Cancelling the dedicated-broker job interrupts it and shuts its broker down.
    const cancel = run("node", [SCRIPT, "cancel", secondId, "--json"], { cwd: repo, env });
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).turnInterrupted, true);
    await waitFor(async () => ((await endpointReachable(secondRunning.brokerEndpoint)) ? null : true));

    run("node", [SCRIPT, "cancel", firstId, "--json"], { cwd: repo, env });
  } finally {
    endSession(repo, env);
  }
});
