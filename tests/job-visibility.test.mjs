import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function uniqueJobId(prefix) {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanEnv(binDir, pluginDataDir = makeTempDir("codex-plugin-data-")) {
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.CODEX_COMPANION_TRANSCRIPT_PATH;
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
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

function stateRootForEnv(env) {
  return env.CLAUDE_PLUGIN_DATA ? path.join(env.CLAUDE_PLUGIN_DATA, "state") : path.join(os.tmpdir(), "codex-companion");
}

function stateDirForRepo(env, repo) {
  let canonical = repo;
  try {
    canonical = fs.realpathSync.native(repo);
  } catch {
    canonical = repo;
  }
  const slug = (path.basename(repo) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(stateRootForEnv(env), `${slug}-${hash}`);
}

function jobFileForRepo(env, repo, jobId) {
  return path.join(stateDirForRepo(env, repo), "jobs", `${jobId}.json`);
}

function writeStateJob(stateDir, job) {
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: {}, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

test("explicit result job id resolves from another workspace state dir", () => {
  const repo = makeRepo();
  const otherRepo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);
  const job = {
    id: uniqueJobId("task-global-result"),
    status: "completed",
    jobClass: "task",
    title: "Codex Task",
    summary: "remote workspace",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: { rawOutput: "found across workspace state dirs" },
    rendered: "found across workspace state dirs\n"
  };
  writeStateJob(stateDirForRepo(env, otherRepo), job);

  const result = run("node", [SCRIPT, "result", job.id, "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, job.id);
  assert.equal(payload.storedJob.result.rawOutput, "found across workspace state dirs");
});

test("wait exits when a globally resolved job file reaches terminal status", async () => {
  const repo = makeRepo();
  const otherRepo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);
  const jobId = uniqueJobId("task-global-wait");
  const startedAt = new Date().toISOString();
  writeStateJob(stateDirForRepo(env, otherRepo), {
    id: jobId,
    status: "running",
    jobClass: "task",
    title: "Codex Task",
    summary: "wait target",
    createdAt: startedAt,
    updatedAt: startedAt
  });

  const child = spawn("node", [SCRIPT, "wait", jobId, "--timeout", "5"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const killTimer = setTimeout(() => child.kill("SIGTERM"), 7000);

  await new Promise((resolve) => setTimeout(resolve, 250));
  writeStateJob(stateDirForRepo(env, otherRepo), {
    id: jobId,
    status: "completed",
    jobClass: "task",
    title: "Codex Task",
    summary: "wait target",
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(killTimer);
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  assert.match(Buffer.concat(stdout).toString("utf8"), /final status: completed/);
});

test("task background accepts prompt stdin and goal file without shell-sensitive prompt loss", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  const env = cleanEnv(binDir);
  const prompt = "Line one with `backticks`\nLine two with $(not executed) and an unbalanced ' quote\n";
  const goalFile = path.join(repo, "goal.txt");
  fs.writeFileSync(goalFile, "Complete the exact quoted prompt handoff.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--background", "--json", "--prompt-stdin", "--goal-file", goalFile], {
    cwd: repo,
    env,
    input: prompt
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const stored = JSON.parse(fs.readFileSync(jobFileForRepo(env, repo, payload.jobId), "utf8"));
  assert.equal(stored.request.prompt, prompt.trim());
  assert.equal(stored.request.goal.objective, "Complete the exact quoted prompt handoff.");
});

test("subcommand help exits before creating a task job", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = cleanEnv(binDir);

  const result = run("node", [SCRIPT, "task", "--help"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(fs.existsSync(jobFileForRepo(env, repo, "--help")), false);
});

test("adversarial-review background prints job id promptly instead of running the review inline", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  const env = cleanEnv(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const start = Date.now();

  const result = run(
    "node",
    [SCRIPT, "adversarial-review", "--background", "--json", "--scope", "working-tree", "focus on quoting"],
    { cwd: repo, env }
  );

  const elapsedMs = Date.now() - start;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 5000, `expected prompt detach, took ${elapsedMs}ms`);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.jobId, /^review-/);
  const stored = JSON.parse(fs.readFileSync(jobFileForRepo(env, repo, payload.jobId), "utf8"));
  assert.ok(stored.status === "queued" || stored.status === "running", `expected queued or running, got ${stored.status}`);
  assert.equal(stored.request.reviewName, "Adversarial Review");
});
