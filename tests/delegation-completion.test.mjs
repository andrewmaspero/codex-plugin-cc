import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildAlertsSnapshot, compactItem } from "../plugins/codex/scripts/lib/control-plane.mts";
import { isSuspectEarlyCompletion } from "../plugins/codex/scripts/lib/task-completion.mts";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mts";

const SCRIPT = path.resolve("plugins/codex/scripts/codex-companion.mts");
const brief = "<delegation>Use two subagents.</delegation><output_contract>verified.txt exists and verification passes.</output_contract>";
function launch(behavior, command = "task", flags = []) {
  const repo = makeTempDir();
  initGitRepo(repo);
  const bin = makeTempDir();
  installFakeCodex(bin, behavior);
  const fakeStatePath = path.join(bin, "fake-codex-state.json");
  const env = buildEnv(bin);
  let threadId;
  if (command === "continue") {
    const initial = run("node", [SCRIPT, "task", "--json", "initialize thread"], { cwd: repo, env });
    assert.equal(initial.status, 0, initial.stderr);
    threadId = JSON.parse(initial.stdout).threadId;
  }
  const args = command === "continue" ? ["continue", threadId] : [command];
  const result = run("node", [SCRIPT, ...args, ...flags, "--json", brief], { cwd: repo, env });
  const jobs = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8")).jobs;
  const job = jobs[0];
  return { result, repo, env, job, fake: JSON.parse(fs.readFileSync(fakeStatePath, "utf8")), log: fs.readFileSync(job.logFile, "utf8") };
}
for (const mode of ["idle", "wait", "drained", "questions-only", "sync-live"]) {
  test(`async delegation ${mode} stays running until actual completion and deliverables`, () => {
    const { result, repo, job, log } = launch(`async-delegation-${mode}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(repo, "verified.txt"), "utf8"), "verified");
    assert.equal(job.status, "completed");
    assert.match(JSON.parse(result.stdout).rawOutput, /verification passed/);
    assert.doesNotMatch(log, /Turn completion inferred/);
  });
}
for (const mode of ["open", "drained"]) {
  test(`genuine early final with ${mode} delegation is auto-continued on the same thread`, () => {
    const { result, repo, job, fake, log } = launch(`early-contract-${mode}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(repo, "verified.txt"), "utf8"), "verified");
    assert.equal(job.status, "completed");
    assert.equal(fake.threads.length, 1);
    assert.equal(fake.threads[0].turns.length, 2);
    assert.match(log, /Auto-continue 1\/2/);
  });
}
test("auto-continue is bounded and exhaustion is alerted, never completed", () => {
  const { result, repo, env, job, fake, log } = launch("early-contract-always");
  assert.notEqual(result.status, 0);
  assert.equal(fake.threads[0].turns.length, 3);
  assert.equal(job.status, "failed");
  assert.equal((log.match(/Auto-continue [12]\/2/g) ?? []).length, 2);
  const alerts = run("node", [SCRIPT, "alerts", job.id, "--no-goals", "--json"], { cwd: repo, env });
  assert.equal(alerts.status, 0, alerts.stderr);
  assert.ok(JSON.parse(alerts.stdout).alerts.some(a => a.kind === "suspect_early_completion"));
});
test("normal completion does not auto-continue", () => {
  const { result, job, fake, log } = launch("review-ok");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(job.status, "completed");
  assert.equal(fake.threads[0].turns.length, 1);
  assert.doesNotMatch(log, /Auto-continue/);
});
test("continue keeps existing behavior", () => {
  const { result, fake, log } = launch("early-contract-always", "continue");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fake.threads[0].turns.length, 2);
  assert.doesNotMatch(log, /Auto-continue/);
});
test("task recovery can be explicitly disabled", () => {
  const { result, fake, log } = launch("early-contract-always", "task", ["--no-auto-continue"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fake.threads[0].turns.length, 1);
  assert.doesNotMatch(log, /Auto-continue/);
});

test("alerts resolves an explicit job from another workspace and a pruned index", async () => {
  const origin = makeTempDir();
  const other = makeTempDir();
  initGitRepo(origin); initGitRepo(other);
  const job = { id: "task-cross-workspace", workspaceRoot: origin, status: "failed", suspectEarlyCompletion: true };
  writeJobFile(origin, job.id, job);
  // Keep only the durable job file, as can happen after state-index pruning.
  upsertJob(origin, { id: "unrelated", workspaceRoot: origin, status: "completed" });
  const snapshot = await buildAlertsSnapshot(other, job.id, { checkGoals: false, reconcileTurns: false });
  assert.equal(snapshot.checkedJobs[0].id, job.id);
  assert.ok(snapshot.alerts.some(a => a.kind === "suspect_early_completion"));
});
test("bounded viewer exposes async delivery/questions and native activity", () => {
  const item = compactItem({ type: "agentMessage", phase: "final_answer", delivery: "async", text: "Continuing", questions: [{ title: "Optional", options: null }] });
  assert.equal(item.delivery, "async");
  assert.equal(item.questions[0].title, "Optional");
  assert.equal(compactItem({ type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/child" }).agentThreadId, "child");
});
test("short normal delegated finals and non-contract tasks remain unchanged", () => {
  for (const text of ["Done.", "All three files verified.", "No response is needed; all deliverables exist and verification passed."]) {
    // The first two are normal successful finals. The last is mixed wording
    // and should not trigger a speculative recovery of already verified work.
    assert.equal(isSuspectEarlyCompletion({ status: 0, delegationObserved: true, finalMessage: text }, brief), false);
  }
  assert.equal(isSuspectEarlyCompletion({ status: 0, delegationObserved: true, finalMessage: "I am proceeding." }, "no contract"), false);
});
