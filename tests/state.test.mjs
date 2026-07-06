import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { fileURLToPath } from "node:url";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mts";
import {
  consumeVisibilityMarkers,
  renderVisibilityAdditionalContext,
  writeVisibilityMarker
} from "../plugins/codex/scripts/lib/native-visibility.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATUSLINE = path.join(ROOT, "plugins", "codex", "scripts", "statusline.mts");

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  // A test run started from inside a Claude Code session inherits
  // CLAUDE_PLUGIN_DATA, which would redirect the state root away from tmp.
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    const canonicalTmpDir = fs.realpathSync.native(os.tmpdir());

    assert.equal(stateDir.startsWith(canonicalTmpDir), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${canonicalTmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("visibility markers are session-scoped and consumed once", () => {
  const workspace = makeTempDir();
  writeVisibilityMarker(workspace, {
    jobId: "task-visible",
    status: "completed",
    summary: "Implemented the native visibility path with tests.",
    timestamp: "2026-07-07T00:00:00.000Z",
    sessionId: "session-a"
  });
  writeVisibilityMarker(workspace, {
    jobId: "task-other",
    status: "failed",
    summary: "Other session failed.",
    timestamp: "2026-07-07T00:01:00.000Z",
    sessionId: "session-b"
  });

  const skipped = consumeVisibilityMarkers(workspace, { sessionId: "session-c" });
  assert.deepEqual(skipped, []);

  const consumed = consumeVisibilityMarkers(workspace, { sessionId: "session-a" });
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].jobId, "task-visible");
  assert.equal(
    renderVisibilityAdditionalContext(consumed),
    "Codex job task-visible completed: Implemented the native visibility path with tests."
  );

  assert.deepEqual(consumeVisibilityMarkers(workspace, { sessionId: "session-a" }), []);

  const explicit = consumeVisibilityMarkers(workspace, { jobId: "task-other" });
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].sessionId, "session-b");
});

test("statusline renders active jobs from local state only", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-statusline",
    status: "running",
    phase: "typing",
    workspaceRoot: workspace,
    createdAt: "2026-07-07T00:00:00.000Z",
    startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivity: {
      text: "typing broker options",
      phase: "typing",
      timestamp: new Date().toISOString()
    }
  };
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);

  const result = run("node", [STATUSLINE, "--cwd", workspace], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^codex: 1 running \| task-statusline /);
  assert.match(result.stdout, /'typing broker options'/);
});
