#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { listWorkspaceJobsForStatusline, oneLineSummary } from "./lib/native-visibility.mts";

const STALLED_MS = 5 * 60 * 1000;

function readStdinJson() {
  if (process.stdin.isTTY) {
    return {};
  }
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parseCwd(argv) {
  const index = argv.indexOf("--cwd");
  if (index !== -1 && argv[index + 1]) {
    return argv[index + 1];
  }
  const input = readStdinJson();
  return input.cwd || input.workspace || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function elapsedMinutes(value) {
  const started = Date.parse(String(value ?? ""));
  if (!Number.isFinite(started)) {
    return "?m";
  }
  return `${Math.max(0, Math.round((Date.now() - started) / 60000))}m`;
}

function activityAgeMs(job) {
  const timestamp = job.lastActivity?.timestamp ?? job.updatedAt ?? job.startedAt ?? job.createdAt;
  const parsed = Date.parse(String(timestamp ?? ""));
  return Number.isFinite(parsed) ? Date.now() - parsed : 0;
}

function activityLabel(job) {
  if (String(job.phase ?? "").toLowerCase() === "stalled" || activityAgeMs(job) >= STALLED_MS) {
    return "STALLED";
  }
  const text = job.lastActivity?.text ?? job.phase ?? job.summary ?? "";
  return text ? `'${oneLineSummary(text, "", 36)}'` : "";
}

function main() {
  const cwd = parseCwd(process.argv.slice(2));
  const active = listWorkspaceJobsForStatusline(cwd).filter((job) => job.status === "queued" || job.status === "running");
  if (active.length === 0) {
    process.stdout.write("codex: idle\n");
    return;
  }

  const details = active.slice(0, 3).map((job) => {
    const parts = [job.id, elapsedMinutes(job.startedAt ?? job.createdAt)];
    const label = activityLabel(job);
    if (label) {
      parts.push(label);
    }
    return parts.join(" ");
  });
  const suffix = active.length > details.length ? ` +${active.length - details.length} more` : "";
  process.stdout.write(`codex: ${active.length} running | ${details.join(" | ")}${suffix}\n`);
}

try {
  main();
} catch {
  process.stdout.write("codex: unavailable\n");
}
