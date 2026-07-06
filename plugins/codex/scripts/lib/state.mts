import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mts";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
let fallbackStateRootDir: string | null = null;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "cancelled";
export type JobPhase =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "reviewing"
  | "completed"
  | "failed"
  | "canceled"
  | string;

export interface JobWorktreeInfo {
  worktreePath?: string | null;
  branchName?: string | null;
  basePath?: string | null;
}

export interface JobRecord {
  id: string;
  kind?: string;
  jobClass?: string;
  title?: string;
  summary?: string;
  status?: JobStatus | string;
  phase?: JobPhase | null;
  pid?: number | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  cwd?: string;
  workspaceRoot?: string;
  threadId?: string | null;
  rootThreadId?: string | null;
  turnId?: string | null;
  sessionId?: string | null;
  logFile?: string | null;
  runCwd?: string | null;
  brokerEndpoint?: string | null;
  brokerTransport?: "shared" | "dedicated" | "direct" | "closed" | string | null;
  worktree?: JobWorktreeInfo | null;
  progress?: string[];
  reasoningSummary?: string[];
  result?: unknown;
  rendered?: string;
  error?: string | null;
  goal?: {
    objective?: string;
    tokenBudget?: number | null;
    status?: string;
  } | null;
  [key: string]: unknown;
}

export interface PluginState {
  version: number;
  config: {
    stopReviewGate: boolean;
    [key: string]: unknown;
  };
  jobs: JobRecord[];
}

export type JobPatch = Partial<JobRecord> & { id: string };
export type JobFilePayload = Partial<JobRecord> & {
  result?: unknown;
  rendered?: string;
};

export interface GlobalJobMatch {
  stateDir: string;
  jobFile: string;
  job: JobRecord;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState(): PluginState {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd: string): string {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(canonicalWorkspaceRoot) || path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateRoot(): string {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    return path.join(pluginDataDir, "state");
  }
  if (!fallbackStateRootDir) {
    const tmpDir = os.tmpdir();
    let canonicalTmpDir = tmpDir;
    try {
      canonicalTmpDir = fs.realpathSync.native(tmpDir);
    } catch {
      canonicalTmpDir = tmpDir;
    }
    fallbackStateRootDir = path.join(canonicalTmpDir, "codex-companion");
  }
  return fallbackStateRootDir;
}

export function resolveStateFile(cwd: string): string {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd: string): void {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd: string): PluginState {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<PluginState>;
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs: JobRecord[]): JobRecord[] {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath?: string | null): void {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeFileAtomic(filePath: string, contents: string): void {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  fs.renameSync(tempPath, filePath);
}

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize read-modify-write cycles on state.json across concurrent
 * companion processes (background workers, steer/goal/status commands).
 * Lock acquisition is best-effort: a stale lock (holder crashed) is stolen,
 * and after the timeout we proceed unlocked rather than fail the command —
 * an interleaved update is preferable to a dead control plane.
 */
function withStateLock<T>(cwd: string, fn: () => T): T {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  const lockToken = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let locked = false;

  while (!locked && Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${lockToken}\n`);
      fs.closeSync(fd);
      locked = true;
    } catch {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (locked) {
      // Only release a lock we still own: it may have been stolen as stale
      // (and re-acquired by another writer) if fn() ran unusually long.
      try {
        if (fs.readFileSync(lockFile, "utf8").trim() === lockToken) {
          fs.unlinkSync(lockFile);
        }
      } catch {
        // Already stolen or removed; nothing to release.
      }
    }
  }
}

export function saveState(cwd: string, state: Partial<PluginState>): PluginState {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd: string, mutate: (state: PluginState) => void): PluginState {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd: string, jobPatch: JobPatch): PluginState {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd: string): JobRecord[] {
  return loadState(cwd).jobs;
}

export function setConfig(cwd: string, key: string, value: unknown): PluginState {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd: string): PluginState["config"] {
  return loadState(cwd).config;
}

export function writeJobFile(cwd: string, jobId: string, payload: JobFilePayload): string {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile: string): JobFilePayload {
  return JSON.parse(fs.readFileSync(jobFile, "utf8")) as JobFilePayload;
}

function listStateDirs(): string[] {
  const stateRoot = resolveStateRoot();
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  return fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(stateRoot, entry.name));
}

function findJobInStateDir(stateDir: string, jobId: string): GlobalJobMatch | null {
  const jobFile = path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    const job = readJobFile(jobFile);
    return typeof job.id === "string" ? { stateDir, jobFile, job: job as JobRecord } : null;
  } catch {
    return null;
  }
}

/**
 * Scan every workspace state dir for still-active jobs tracking `threadId`.
 * Used by the codex notify hook, which only knows the thread id: the payload
 * cwd may be a worktree whose state lives under the original workspace.
 */
export function listActiveJobsByThreadId(threadId: string | null | undefined): Array<{ stateDir: string; job: JobRecord }> {
  if (!threadId) {
    return [];
  }
  const matches: Array<{ stateDir: string; job: JobRecord }> = [];
  for (const stateDir of listStateDirs()) {
    const stateFile = path.join(stateDir, STATE_FILE_NAME);
    if (!fs.existsSync(stateFile)) {
      continue;
    }
    let jobs;
    try {
      jobs = (JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<PluginState>).jobs ?? [];
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (job.threadId === threadId && (job.status === "running" || job.status === "queued")) {
        matches.push({ stateDir, job });
      }
    }
  }
  return matches;
}

/**
 * Worktree paths referenced by still-active jobs across every workspace state
 * dir; `worktrees --prune` must never remove a tree a running job executes in.
 */
export function listActiveWorktreePaths(): string[] {
  const paths = new Set<string>();
  for (const stateDir of listStateDirs()) {
    const stateFile = path.join(stateDir, STATE_FILE_NAME);
    if (!fs.existsSync(stateFile)) {
      continue;
    }
    let jobs;
    try {
      jobs = (JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<PluginState>).jobs ?? [];
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (job.status !== "running" && job.status !== "queued") {
        continue;
      }
      const worktreePath = job.worktree?.worktreePath ?? null;
      if (worktreePath) {
        paths.add(worktreePath);
      }
    }
  }
  return [...paths];
}

export function resolveJobFileGlobally(cwd: string, jobId: string): GlobalJobMatch | null {
  const current = findJobInStateDir(resolveStateDir(cwd), jobId);
  if (current) {
    return current;
  }

  for (const stateDir of listStateDirs()) {
    const match = findJobInStateDir(stateDir, jobId);
    if (match) {
      return match;
    }
  }

  return null;
}

function removeJobFile(jobFile: string): void {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd: string, jobId: string): string {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd: string, jobId: string): string {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
