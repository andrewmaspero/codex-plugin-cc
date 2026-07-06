import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "vitest";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, reapOrphanedJobs } from "../plugins/codex/scripts/lib/job-control.mts";
import { buildAlertsSnapshot } from "../plugins/codex/scripts/lib/control-plane.mts";
import { listJobs, upsertJob } from "../plugins/codex/scripts/lib/state.mts";
import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/tracked-jobs.mts";

function withoutSessionId(fn) {
  const previous = process.env[SESSION_ID_ENV];
  delete process.env[SESSION_ID_ENV];
  try {
    return fn();
  } finally {
    if (previous !== undefined) {
      process.env[SESSION_ID_ENV] = previous;
    }
  }
}

function seedRunningJob(workspace, overrides = {}) {
  const logFile = path.join(workspace, `${overrides.id ?? "job-reaper-test"}.log`);
  fs.writeFileSync(logFile, "[2026-07-06T00:00:00.000Z] Starting Codex Task.\n", "utf8");
  upsertJob(workspace, {
    id: "job-reaper-test",
    jobClass: "task",
    status: "running",
    phase: "running",
    pid: 99999999,
    logFile,
    startedAt: new Date().toISOString(),
    ...overrides
  });
  return logFile;
}

test("reaper marks a running job with a dead worker failed/orphaned", () => {
  withoutSessionId(() => {
    const workspace = makeTempDir();
    const logFile = seedRunningJob(workspace);

    const jobs = reapOrphanedJobs(workspace, listJobs(workspace), { isProcessAlive: () => false });
    const job = jobs.find((candidate) => candidate.id === "job-reaper-test");

    assert.equal(job.status, "failed");
    assert.equal(job.phase, "orphaned");
    assert.equal(job.pid, null);
    assert.match(job.errorMessage, /orphan reaper/);
    assert.match(fs.readFileSync(logFile, "utf8"), /died without recording a result/);
  });
});

test("status snapshot reports a reaped job as finished, not running", () => {
  withoutSessionId(() => {
    const workspace = makeTempDir();
    seedRunningJob(workspace);

    const snapshot = buildStatusSnapshot(workspace, { isProcessAlive: () => false });

    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.latestFinished?.id, "job-reaper-test");
    assert.equal(snapshot.latestFinished?.status, "failed");

    const single = buildSingleJobSnapshot(workspace, "job-reaper-test", { isProcessAlive: () => false });
    assert.equal(single.job.status, "failed");
  });
});

test("reaper leaves live and already-finished jobs untouched", () => {
  withoutSessionId(() => {
    const workspace = makeTempDir();
    seedRunningJob(workspace, { id: "job-live", pid: process.pid });
    seedRunningJob(workspace, { id: "job-done", status: "completed", phase: "done", pid: 99999999 });

    const jobs = reapOrphanedJobs(workspace, listJobs(workspace), {});
    assert.equal(jobs.find((job) => job.id === "job-live").status, "running");
    assert.equal(jobs.find((job) => job.id === "job-done").status, "completed");
  });
});

test("alerts snapshot converts an orphan into a terminal failed alert", async () => {
  await withoutSessionId(async () => {
    const workspace = makeTempDir();
    seedRunningJob(workspace);

    const payload = await buildAlertsSnapshot(workspace, "", {
      isProcessAlive: () => false,
      checkGoals: false
    });

    const failed = payload.alerts.find((alert) => alert.jobId === "job-reaper-test" && alert.kind === "failed");
    assert.ok(failed, "expected a failed alert for the reaped job");
    assert.equal(
      payload.checkedJobs.find((job) => job.id === "job-reaper-test").status,
      "failed"
    );
  });
});
