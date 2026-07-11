// OBS-B: a worker whose broker (and thus app-server connection) dies mid-turn
// previously exited 0 silently — the completion promise never settled, every
// timer was unref'd, the event loop drained, and the job stayed "running"
// forever with no trace. The capture must instead reject on connection loss so
// the job records a precise terminal failure.
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mts";
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

test("worker records a terminal failure when the broker dies mid-turn", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);

  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "long investigation"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;

    const running = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.turnId ? job : null;
    });

    // Kill the shared broker (and its app-server) mid-turn, exactly like a
    // concurrent session's SessionEnd or a broker replacement does.
    const broker = loadBrokerSession(repo);
    assert.ok(broker?.pid, "no shared broker session recorded");
    fs.appendFileSync(broker.logFile, "broker diagnostic sentinel\n", "utf8");
    process.kill(broker.pid, "SIGKILL");

    const done = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job && job.status !== "running" && job.status !== "queued" ? job : null;
    });

    assert.equal(done.status, "interrupted", `job should be recoverably interrupted, got: ${JSON.stringify(done)}`);
    assert.match(
      String(done.errorMessage ?? ""),
      /connection closed|exited unexpectedly|closed before the turn completed/i,
      `errorMessage should explain the connection loss: ${done.errorMessage}`
    );
    const log = fs.readFileSync(done.logFile, "utf8");
    assert.match(
      log,
      /connection closed|exited unexpectedly|closed before the turn completed/i,
      "job log should record the connection loss"
    );
    assert.match(log, /broker diagnostic sentinel/, "job log should capture the broker stderr tail");
    const stored = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "jobs", `${jobId}.json`), "utf8"));
    assert.match(String(stored.result?.rawOutput ?? ""), /interrupted/i);
    assert.match(String(stored.result?.rawOutput ?? ""), new RegExp(`continue ${stored.threadId} --prompt-stdin`));
    assert.ok(running.pid, "running job had no pid");
  } finally {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  }
});

test("broker propagates an app-server crash and its stderr tail to the job", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "app-server-dies-mid-turn");
  const env = cleanEnv(binDir);
  env.CODEX_COMPANION_IDLE_RECONCILE_MS = "0";

  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "crash app server"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;
    const done = await waitFor(
      () => {
        const job = readJobs(repo).find((candidate) => candidate.id === jobId);
        return job && job.status !== "running" && job.status !== "queued" ? job : null;
      },
      { timeoutMs: 5000 }
    );

    assert.equal(done.status, "interrupted");
    const log = fs.readFileSync(done.logFile, "utf8");
    assert.match(log, /fake app-server crash sentinel/);
    assert.match(log, /exit 17/);
  } finally {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  }
});

test("ending one Claude session does not kill another session's live shared-broker job", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const env = cleanEnv(binDir);
  env.CODEX_COMPANION_SESSION_ID = "session-a";
  env.FAKE_CODEX_HOLD_TURNS = "1";

  let workerPid = null;
  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "session A live turn"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;
    const running = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.turnId ? job : null;
    });
    workerPid = running.pid;
    const broker = loadBrokerSession(repo);
    assert.ok(broker?.pid);

    const otherSessionEnv = { ...env, CODEX_COMPANION_SESSION_ID: "session-b" };
    const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: otherSessionEnv,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "session-b" })
    });
    assert.equal(ended.status, 0, ended.stderr);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = readJobs(repo).find((candidate) => candidate.id === jobId);
    assert.equal(after.status, "running", `session B killed session A's job: ${JSON.stringify(after)}`);
    assert.doesNotThrow(() => process.kill(broker.pid, 0));
  } finally {
    if (workerPid) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {}
    }
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "session-a" })
    });
  }
});
