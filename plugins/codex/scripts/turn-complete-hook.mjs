#!/usr/bin/env node
/**
 * Codex-side turn-completion finalizer.
 *
 * Wired as the `notify` hook (-c notify=[...]) on every codex app-server the
 * plugin spawns. Codex invokes it with an agent-turn-complete JSON payload as
 * the last argv argument the moment a turn finishes:
 *   {"type":"agent-turn-complete","thread-id":"...","turn-id":"...","cwd":"...",
 *    "input-messages":[...],"last-assistant-message":"..."}
 *
 * This makes job finalization durable even when the Node worker died or hung
 * mid-turn (OBS-A/OBS-B): if the tracked job for the thread is still marked
 * running after a grace window with no log activity, the hook records the
 * terminal state and result itself. A healthy worker always wins the race —
 * the hook only touches jobs that stayed active AND silent through the grace.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { listActiveJobsByThreadId, readJobFile, resolveJobFile, updateState, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, nowIso } from "./lib/tracked-jobs.mjs";

const GRACE_MS = Math.max(0, Number(process.env.CODEX_COMPANION_HOOK_GRACE_MS) || 8000);
const POLL_MS = Math.min(1000, Math.max(50, GRACE_MS || 50));

function parsePayload(argv) {
  const raw = argv.at(-1);
  if (!raw) {
    return null;
  }
  try {
    const payload = JSON.parse(raw);
    return payload?.type === "agent-turn-complete" ? payload : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActive(job) {
  return job?.status === "running" || job?.status === "queued";
}

function logMtime(job) {
  if (!job.logFile) {
    return null;
  }
  try {
    return fs.statSync(job.logFile).mtimeMs;
  } catch {
    return null;
  }
}

function finalizeJob(match, payload) {
  const workspaceRoot = match.job.workspaceRoot;
  if (!workspaceRoot) {
    return false;
  }
  const lastMessage = typeof payload["last-assistant-message"] === "string" ? payload["last-assistant-message"] : "";
  const completedAt = nowIso();
  const note = `Turn completion recorded by the Codex notify hook (turn ${payload["turn-id"] ?? "?"}); the worker did not finalize this job itself.`;
  const patch = {
    status: "completed",
    phase: "done",
    pid: null,
    completedAt,
    turnId: match.job.turnId ?? payload["turn-id"] ?? null,
    reconciledBy: "codex-notify-hook"
  };

  let finalized = false;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex((candidate) => candidate.id === match.job.id);
    if (index === -1) {
      return;
    }
    const current = state.jobs[index];
    if (!isActive(current)) {
      return;
    }
    state.jobs[index] = {
      ...current,
      ...patch,
      summary: lastMessage ? lastMessage.split(/\r?\n/).find(Boolean) ?? current.summary : current.summary,
      updatedAt: completedAt
    };
    finalized = true;
  });

  if (!finalized) {
    return false;
  }

  const jobFile = resolveJobFile(workspaceRoot, match.job.id);
  let stored = {};
  try {
    stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : {};
  } catch {
    stored = {};
  }
  writeJobFile(workspaceRoot, match.job.id, {
    ...stored,
    ...patch,
    result: stored.result ?? {
      status: 0,
      threadId: payload["thread-id"] ?? match.job.threadId ?? null,
      rawOutput: lastMessage,
      reconciledBy: "codex-notify-hook"
    },
    rendered: stored.rendered ?? (lastMessage || note)
  });
  appendLogLine(match.job.logFile, note);
  return true;
}

async function main() {
  const payload = parsePayload(process.argv.slice(2));
  const threadId = payload?.["thread-id"];
  if (!threadId) {
    return;
  }

  let matches = listActiveJobsByThreadId(threadId);
  if (matches.length === 0) {
    return;
  }

  // Snapshot each job log's mtime, then give the worker (which sees the same
  // turn/completed notification) the grace window to finalize normally. A
  // healthy worker either flips the job terminal (dropped from matches) or
  // keeps writing progress lines (mtime advances) — only a frozen job gets
  // finalized here.
  const initialMtimes = new Map(matches.map((match) => [match.job.id, logMtime(match.job)]));
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    matches = listActiveJobsByThreadId(threadId);
    if (matches.length === 0) {
      return;
    }
  }

  for (const match of matches) {
    if (!isActive(match.job)) {
      continue;
    }
    const before = initialMtimes.get(match.job.id);
    const after = logMtime(match.job);
    if (before != null && after != null && after > before) {
      // The worker wrote log lines during the grace: it is alive and
      // streaming this thread's events; let it finalize the job itself.
      continue;
    }
    try {
      finalizeJob(match, payload);
    } catch {
      // Best-effort: never let one job's failure stop the others.
    }
  }
}

main().catch(() => {
  // The hook runs detached with no stdio; swallow everything.
});
