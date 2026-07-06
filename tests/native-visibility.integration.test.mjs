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

test("fake Codex task captures lastActivity from assistant progress", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  try {
    const launch = run("node", [SCRIPT, "task", "--background", "--json", "capture activity"], { cwd: repo, env });
    assert.equal(launch.status, 0, launch.stderr);
    const jobId = JSON.parse(launch.stdout).jobId;

    const done = await waitFor(() => {
      const job = readJobs(repo).find((candidate) => candidate.id === jobId);
      return job?.status === "completed" && /Handled the requested task/i.test(job.lastActivity?.text ?? "") ? job : null;
    });

    assert.equal(done.status, "completed", `job did not complete: ${JSON.stringify(done)}`);
    assert.match(done.lastActivity?.text ?? "", /Handled the requested task/i);
    assert.ok(done.lastActivity?.timestamp, "lastActivity timestamp missing");

    const status = run("node", [SCRIPT, "status", jobId], { cwd: repo, env });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Last activity:/);
  } finally {
    endSession(repo, env);
  }
});
