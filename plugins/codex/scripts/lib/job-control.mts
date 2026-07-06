import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mts";
import { isProcessAlive } from "./process.mts";
import { getConfig, listJobs, readJobFile, resolveJobFile, resolveJobFileGlobally, updateState, writeJobFile } from "./state.mts";
import type { JobRecord } from "./state.mts";
import { appendLogLine, SESSION_ID_ENV } from "./tracked-jobs.mts";
import { resolveWorkspaceRoot } from "./workspace.mts";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

interface SessionFilterOptions {
  env?: NodeJS.ProcessEnv;
}

interface EnrichJobOptions {
  maxProgressLines?: number;
}

interface ReapOrphanedJobsOptions {
  isProcessAlive?: (pid: number) => boolean | null;
}

interface StatusSnapshotOptions extends SessionFilterOptions, EnrichJobOptions, ReapOrphanedJobsOptions {
  maxJobs?: number;
  all?: boolean;
}

type SingleJobSnapshotOptions = EnrichJobOptions & ReapOrphanedJobsOptions;
type ResolveCancelableJobOptions = SessionFilterOptions;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options: SessionFilterOptions = {}): string | null {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs: JobRecord[], options: SessionFilterOptions = {}): JobRecord[] {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job: JobRecord, options: EnrichJobOptions = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot: string, jobId: string): JobRecord | null {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  const job = readJobFile(jobFile);
  return typeof job.id === "string" ? (job as JobRecord) : null;
}

function matchJobReference(jobs: JobRecord[], reference: string, predicate: (job: JobRecord) => boolean = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

function orphanMessage(pid) {
  return `Worker process ${pid} died without recording a result; marked failed by the orphan reaper.`;
}

// A background worker records its own completion before exiting, so a job that
// is still "running"/"queued" while its pid is dead can never finish on its
// own — every status/alerts poll would report "running" forever (observed: a
// zombie job sat for 60 minutes; the canonical wait poller never woke). Reap
// such jobs to "failed" at read time so any poller sees a terminal state
// within one poll cycle. The status re-check runs inside the state lock: if
// the worker wrote "completed" between our snapshot read and this write, the
// job is no longer active and we leave it untouched.
export function reapOrphanedJobs(workspaceRoot: string, jobs: JobRecord[], options: ReapOrphanedJobsOptions = {}): JobRecord[] {
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  let reapedAny = false;

  for (const job of jobs) {
    const active = job.status === "running" || job.status === "queued";
    if (!active || isAlive(job.pid) !== false) {
      continue;
    }

    const completedAt = new Date().toISOString();
    const patch = {
      status: "failed",
      phase: "orphaned",
      pid: null,
      completedAt,
      errorMessage: orphanMessage(job.pid)
    };

    let reaped = false;
    updateState(workspaceRoot, (state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index === -1) {
        return;
      }
      const current = state.jobs[index];
      const stillActive = current.status === "running" || current.status === "queued";
      if (!stillActive || current.pid !== job.pid) {
        return;
      }
      state.jobs[index] = { ...current, ...patch, updatedAt: completedAt };
      reaped = true;
    });

    if (!reaped) {
      continue;
    }
    reapedAny = true;
    const stored = readStoredJob(workspaceRoot, job.id);
    if (stored) {
      writeJobFile(workspaceRoot, job.id, { ...stored, ...patch });
    }
    appendLogLine(job.logFile, orphanMessage(job.pid));
  }

  return reapedAny ? listJobs(workspaceRoot) : jobs;
}

export function buildStatusSnapshot(cwd: string, options: StatusSnapshotOptions = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(reapOrphanedJobs(workspaceRoot, listJobs(workspaceRoot), options), options)
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd: string, reference: string, options: SingleJobSnapshotOptions = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (reference) {
    const globalMatch = resolveJobFileGlobally(workspaceRoot, reference);
    if (globalMatch) {
      // Cross-workspace hits must still be reaped, in the job's own workspace,
      // so a dead worker surfaces as failed/orphaned instead of running forever.
      const jobWorkspaceRoot = globalMatch.job.workspaceRoot ?? workspaceRoot;
      const reaped = reapOrphanedJobs(jobWorkspaceRoot, [globalMatch.job], options).find(
        (job) => job.id === globalMatch.job.id
      );
      return {
        workspaceRoot: jobWorkspaceRoot,
        job: enrichJob(reaped ?? globalMatch.job, { maxProgressLines: options.maxProgressLines }),
        jobFile: globalMatch.jobFile,
        stateDir: globalMatch.stateDir
      };
    }
  }

  const jobs = sortJobsNewestFirst(reapOrphanedJobs(workspaceRoot, listJobs(workspaceRoot), options));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (reference) {
    const globalMatch = resolveJobFileGlobally(workspaceRoot, reference);
    if (globalMatch) {
      const job = globalMatch.job;
      if (job.status === "queued" || job.status === "running") {
        throw new Error(`Job ${job.id} is still ${job.status}. Check /codex:status and try again once it finishes.`);
      }
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        return {
          workspaceRoot: job.workspaceRoot ?? workspaceRoot,
          job,
          storedJob: job,
          jobFile: globalMatch.jobFile,
          stateDir: globalMatch.stateDir
        };
      }
    }
  }

  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  let selected;
  try {
    selected = matchJobReference(
      jobs,
      reference,
      (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
    );
  } catch (error) {
    // A referenced job may exist but still be active; report that instead of
    // "no job found".
    const activeMatch = reference
      ? jobs.find(
          (job) => (job.id === reference || job.id.startsWith(reference)) && (job.status === "queued" || job.status === "running")
        )
      : null;
    if (activeMatch) {
      throw new Error(`Job ${activeMatch.id} is still ${activeMatch.status}. Check /codex:status and try again once it finishes.`);
    }
    throw error;
  }

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd: string, reference: string, options: ResolveCancelableJobOptions = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    let localSelected = activeJobs.find((job) => job.id === reference) ?? null;
    if (!localSelected) {
      const prefixMatches = activeJobs.filter((job) => job.id.startsWith(reference));
      if (prefixMatches.length > 1) {
        throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
      }
      localSelected = prefixMatches[0] ?? null;
    }
    if (localSelected) {
      return { workspaceRoot, job: localSelected };
    }

    const globalMatch = resolveJobFileGlobally(workspaceRoot, reference);
    if (globalMatch) {
      const job = globalMatch.job;
      if (job.status !== "queued" && job.status !== "running") {
        throw new Error(`Job ${job.id} is ${job.status}; only active jobs can be cancelled.`);
      }
      return {
        workspaceRoot: job.workspaceRoot ?? workspaceRoot,
        job,
        storedJob: job,
        jobFile: globalMatch.jobFile,
        stateDir: globalMatch.stateDir
      };
    }
    throw new Error(`No active job found for "${reference}".`);
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
