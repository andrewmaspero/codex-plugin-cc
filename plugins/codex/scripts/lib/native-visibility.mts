import fs from "node:fs";
import path from "node:path";

import { listJobs, readJobFile, resolveJobFile, resolveStateDir } from "./state.mts";
import type { JobRecord, JobStatus } from "./state.mts";
import { resolveWorkspaceRoot } from "./workspace.mts";

const MARKERS_DIR_NAME = "visibility-markers";
const SUMMARY_LIMIT = 120;

export interface JobLastActivity {
  text: string;
  phase?: string | null;
  timestamp: string;
}

export interface VisibilityMarker {
  jobId: string;
  status: JobStatus | string;
  summary: string;
  timestamp: string;
  workspaceRoot?: string | null;
  sessionId?: string | null;
}

interface ConsumeOptions {
  sessionId?: string | null;
  jobId?: string | null;
}

function compactWhitespace(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function oneLineSummary(value: unknown, fallback = "No summary captured.", limit = SUMMARY_LIMIT): string {
  const normalized = compactWhitespace(value) || fallback;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 3))}...`;
}

export function buildLastActivity(event: { message?: unknown; phase?: string | null }, timestamp = new Date().toISOString()): JobLastActivity | null {
  const text = oneLineSummary(event.message, "", SUMMARY_LIMIT);
  if (!text) {
    return null;
  }
  return {
    text,
    phase: event.phase ?? null,
    timestamp
  };
}

export function formatLastActivity(activity?: JobLastActivity | null): string {
  if (!activity?.text) {
    return "";
  }
  const phase = activity.phase ? `${activity.phase} ` : "";
  return `${phase}${activity.text} (${activity.timestamp})`;
}

export function resolveVisibilityMarkersDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), MARKERS_DIR_NAME);
}

function safeMarkerFileName(marker: VisibilityMarker): string {
  const safeJobId = marker.jobId.replace(/[^a-zA-Z0-9._-]+/g, "-") || "job";
  const safeTime = marker.timestamp.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${safeTime}-${safeJobId}-${random}.json`;
}

function writeFileAtomic(filePath: string, contents: string): void {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function writeVisibilityMarker(cwd: string, markerInput: VisibilityMarker): string {
  const workspaceRoot = markerInput.workspaceRoot ?? resolveWorkspaceRoot(cwd);
  const marker: VisibilityMarker = {
    ...markerInput,
    workspaceRoot,
    summary: oneLineSummary(markerInput.summary),
    timestamp: markerInput.timestamp || new Date().toISOString()
  };
  const dir = resolveVisibilityMarkersDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeMarkerFileName(marker));
  writeFileAtomic(filePath, `${JSON.stringify(marker, null, 2)}\n`);
  return filePath;
}

export function writeJobVisibilityMarker(cwd: string, job: JobRecord, status: JobStatus | string, summary?: string | null): string {
  const fallbackSummary = `${typeof job.title === "string" && job.title ? job.title : "Codex job"} ${status}`;
  return writeVisibilityMarker(job.workspaceRoot ?? cwd, {
    jobId: job.id,
    status,
    summary: summary ?? (typeof job.summary === "string" ? job.summary : null) ?? (typeof job.errorMessage === "string" ? job.errorMessage : null) ?? fallbackSummary,
    timestamp: new Date().toISOString(),
    workspaceRoot: job.workspaceRoot ?? resolveWorkspaceRoot(cwd),
    sessionId: job.sessionId ?? null
  });
}

function readMarker(filePath: string): VisibilityMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<VisibilityMarker>;
    if (!parsed.jobId || !parsed.status || !parsed.timestamp) {
      return null;
    }
    return {
      jobId: parsed.jobId,
      status: parsed.status,
      summary: oneLineSummary(parsed.summary),
      timestamp: parsed.timestamp,
      workspaceRoot: parsed.workspaceRoot ?? null,
      sessionId: parsed.sessionId ?? null
    };
  } catch {
    return null;
  }
}

export function consumeVisibilityMarkers(cwd: string, options: ConsumeOptions = {}): VisibilityMarker[] {
  if (!options.jobId && !options.sessionId) {
    return [];
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const dir = resolveVisibilityMarkersDir(workspaceRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(dir, entry))
    .sort();

  const consumed: VisibilityMarker[] = [];
  for (const filePath of files) {
    const marker = readMarker(filePath);
    if (!marker) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup races.
      }
      continue;
    }
    const explicitMatch = options.jobId && marker.jobId === options.jobId;
    const sessionMatch = !options.jobId && (!options.sessionId || marker.sessionId === options.sessionId);
    if (!explicitMatch && !sessionMatch) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      continue;
    }
    consumed.push(marker);
  }
  return consumed;
}

export function renderVisibilityAdditionalContext(markers: VisibilityMarker[]): string {
  return markers.map((marker) => `Codex job ${marker.jobId} ${marker.status}: ${marker.summary}`).join("\n");
}

export function readJobFromDisk(workspaceRoot: string, job: JobRecord): JobRecord {
  const jobFile = resolveJobFile(workspaceRoot, job.id);
  if (!fs.existsSync(jobFile)) {
    return job;
  }
  try {
    return { ...job, ...(readJobFile(jobFile) as JobRecord) };
  } catch {
    return job;
  }
}

export function listWorkspaceJobsForStatusline(cwd: string): JobRecord[] {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return listJobs(workspaceRoot).map((job) => readJobFromDisk(workspaceRoot, job));
}
