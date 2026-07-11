import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mts";
import type { JobPatch, JobRecord } from "./state.mts";
import { buildLastActivity, oneLineSummary, writeJobVisibilityMarker } from "./native-visibility.mts";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

interface CreateJobRecordOptions {
  env?: NodeJS.ProcessEnv;
  sessionIdEnv?: string;
}

interface TrackedJobExecution {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  payload?: unknown;
  rendered?: string;
  summary?: string;
}

interface RunTrackedJobOptions {
  logFile?: string | null;
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base: JobRecord, options: CreateJobRecordOptions = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch: JobPatch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    const assistantCapsule =
      normalized.logTitle === "Assistant message" || /^Subagent .+ message$/.test(normalized.logTitle ?? "");
    const lastActivity = assistantCapsule
      ? buildLastActivity({ message: normalized.logBody ?? normalized.message, phase: normalized.phase })
      : null;
    if (lastActivity) {
      patch.lastActivity = lastActivity;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job: JobRecord, runner: () => Promise<TrackedJobExecution>, options: RunTrackedJobOptions = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const terminalSummary = oneLineSummary(
      execution.summary ?? execution.rendered ?? (execution.payload as { rawOutput?: unknown } | null)?.rawOutput,
      `${job.title ?? "Codex job"} ${completionStatus}`
    );
    // Spread the CURRENT stored record, not the job-start snapshot: mid-turn
    // patches (lastActivity capsules, threadId updates) must survive the
    // terminal write. The catch path below already does this.
    const currentRecord = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, {
      ...currentRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      summary: terminalSummary,
      errorMessage: null,
      reconciledBy: null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: terminalSummary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      errorMessage: null,
      reconciledBy: null
    });
    writeJobVisibilityMarker(job.workspaceRoot, { ...job, ...runningRecord }, completionStatus, terminalSummary);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    const recoverable = error && typeof error === "object" ? (error as { recoveryText?: string; threadId?: string }).recoveryText : null;
    const terminalStatus = recoverable ? "interrupted" : "failed";
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: terminalStatus,
      phase: terminalStatus,
      errorMessage,
      pid: null,
      completedAt,
      ...(recoverable
        ? {
            result: {
              status: 1,
              threadId: (error as { threadId?: string }).threadId ?? existing.threadId ?? null,
              rawOutput: recoverable,
              interrupted: true
            },
            rendered: recoverable
          }
        : {}),
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: terminalStatus,
      phase: terminalStatus,
      pid: null,
      errorMessage,
      completedAt
    });
    writeJobVisibilityMarker(job.workspaceRoot, { ...job, ...existing }, terminalStatus, recoverable ?? errorMessage);
    throw error;
  }
}
