// Regression: continue --background against a thread the shared broker's
// app-server has loaded must stream progress events into the job log even
// when a server-initiated turn (goal evaluation / auto-compaction) is
// interleaved on the same thread. Previously the internal turn's
// turn/completed released the broker's stream ownership, so every event of
// the job's real turn was dropped and the log froze after "Thread ready"
// (OBS-F, 2026-07-06-orphaned-worker-reaper.md).
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

test("continue streams progress events when a server-initiated turn is interleaved on the resumed thread", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "internal-turn-on-resume");
  const env = cleanEnv(binDir);

  try {
    const first = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failure"], { cwd: repo, env });
    assert.equal(first.status, 0, first.stderr);
    const firstId = JSON.parse(first.stdout).jobId;
    const firstDone = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === firstId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    });
    assert.equal(firstDone.status, "completed", `first job failed: ${JSON.stringify(firstDone)}`);
    assert.ok(firstDone.threadId, "first job recorded no thread id");

    const second = run("node", [SCRIPT, "continue", firstDone.threadId, "--background", "--json", "keep going"], {
      cwd: repo,
      env
    });
    assert.equal(second.status, 0, second.stderr);
    const secondId = JSON.parse(second.stdout).jobId;
    const secondDone = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === secondId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    });

    assert.equal(secondDone.status, "completed", `continue job did not complete: ${JSON.stringify(secondDone)}`);

    // The real turn's id (not the internal server turn, not the response id)
    // must have been latched from its turn/started notification.
    assert.ok(
      String(secondDone.turnId ?? "").startsWith("real_"),
      `continue job latched wrong turn id: ${secondDone.turnId}`
    );

    const log = fs.readFileSync(secondDone.logFile, "utf8");
    assert.match(log, /Thread ready/, "continue log lost its startup lines");
    assert.match(log, /Turn started \(real_/, "continue log has no turn/started progress event");
    assert.match(log, /Turn completed\./, "continue log has no turn/completed progress event");
    // The internal server turn's noise must not be recorded as this job's turn.
    assert.doesNotMatch(log, /Turn started \(internal_/, "internal server turn leaked into the job log as a root turn");
  } finally {
    endSession(repo, env);
  }
});

test("continue adopts an active turn that absorbed its prompt and finalizes with its result", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "absorbed-turn-on-resume");
  const env = cleanEnv(binDir);

  try {
    const first = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failure"], { cwd: repo, env });
    assert.equal(first.status, 0, first.stderr);
    const firstId = JSON.parse(first.stdout).jobId;
    const firstDone = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === firstId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    });
    assert.equal(firstDone.status, "completed", `first job failed: ${JSON.stringify(firstDone)}`);

    const second = run("node", [SCRIPT, "continue", firstDone.threadId, "--background", "--json", "keep going"], {
      cwd: repo,
      env
    });
    assert.equal(second.status, 0, second.stderr);
    const secondId = JSON.parse(second.stdout).jobId;
    const secondDone = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === secondId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    });

    assert.equal(secondDone.status, "completed", `continue job did not complete: ${JSON.stringify(secondDone)}`);
    assert.ok(
      String(secondDone.turnId ?? "").startsWith("internal_"),
      `continue job should have adopted the absorbing turn, got: ${secondDone.turnId}`
    );

    const log = fs.readFileSync(secondDone.logFile, "utf8");
    assert.match(log, /Adopted live turn internal_/, "continue log shows no turn adoption");
    assert.match(log, /Assistant message captured/, "adopted turn's assistant message was not captured");

    const result = run("node", [SCRIPT, "result", secondId, "--json"], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(
      String(payload.storedJob?.result?.rawOutput ?? ""),
      /Handled the requested task/,
      "absorbed turn's final answer was not stored as the job result"
    );
  } finally {
    endSession(repo, env);
  }
});
