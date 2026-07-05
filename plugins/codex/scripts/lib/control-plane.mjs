/**
 * Token-efficient control-plane helpers: steering active turns, reading Codex
 * threads in bounded slices, tailing job logs, and drift/stall alerts.
 *
 * Every read path here must stay bounded. `thread/read` with `includeTurns`
 * can return tens of megabytes for a long thread, so viewers prefer the
 * paginated `thread/turns/list` API and always compact locally before
 * printing anything the calling agent will ingest.
 */
import fs from "node:fs";

import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./app-server.mjs";
import { steerAppServerTurn } from "./codex.mjs";
import { listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { enrichJob, sortJobsNewestFirst } from "./job-control.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STEER_SOFT_WORD_LIMIT = 300;
export const STEER_HARD_WORD_LIMIT = 800;
export const STEER_HARD_CHAR_LIMIT = 6000;

export const DEFAULT_THREADS_LIMIT = 10;
export const DEFAULT_TURNS_LIMIT = 10;
export const DEFAULT_ITEMS_LIMIT = 20;
export const DEFAULT_ITEMS_BUDGET_CHARS = 4000;
export const DEFAULT_TAIL_LINES = 20;
export const MAX_TAIL_LINES = 200;

const MAX_TURN_PAGES_PER_SCAN = 5;
const TURNS_PAGE_SIZE = 20;
const DEFAULT_STALL_SECONDS = 180;
const LONG_RUNNING_SECONDS = 30 * 60;
const REPEATED_FAILURE_THRESHOLD = 3;

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function formatTimestamp(value) {
  if (value == null) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  const ms = number > 1e12 ? number : number * 1000;
  return new Date(ms).toISOString();
}

function isMethodUnavailableError(error) {
  const message = String(error?.message ?? "");
  return (
    error?.rpcCode === -32601 ||
    message.includes("unknown variant") ||
    message.includes("Unsupported method") ||
    message.includes("requires experimentalApi")
  );
}

// --- steering -------------------------------------------------------------

export function validateSteerMessage(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    throw new Error("Steer message is empty. Provide a short corrective instruction after the job id.");
  }
  if (normalized.length > STEER_HARD_CHAR_LIMIT || countWords(normalized) > STEER_HARD_WORD_LIMIT) {
    throw new Error(
      `Steer message is too long (max ${STEER_HARD_WORD_LIMIT} words). Steering is a short correction delta, not a new brief. Cancel and relaunch with a fresh prompt instead.`
    );
  }
  return normalized;
}

export function resolveSteerableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  let job = null;
  if (reference) {
    job = activeJobs.find((candidate) => candidate.id === reference) ?? null;
    if (!job) {
      const prefixMatches = activeJobs.filter((candidate) => candidate.id.startsWith(reference));
      if (prefixMatches.length > 1) {
        throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
      }
      job = prefixMatches[0] ?? null;
    }
    if (!job) {
      const finished = jobs.find((candidate) => candidate.id === reference || candidate.id.startsWith(reference));
      if (finished) {
        throw new Error(
          `Job ${finished.id} is ${finished.status}, so there is no active turn to steer. Use /codex:continue ${finished.threadId ?? "<thread-id>"} for a follow-up turn instead.`
        );
      }
      throw new Error(`No active job found for "${reference}". Run /codex:status to list jobs.`);
    }
  } else {
    if (activeJobs.length === 0) {
      throw new Error("No active Codex jobs to steer.");
    }
    if (activeJobs.length > 1) {
      throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:steer.");
    }
    job = activeJobs[0];
  }

  const stored = fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? readJobFile(resolveJobFile(workspaceRoot, job.id)) : {};
  const threadId = job.threadId ?? stored.threadId ?? null;
  const turnId = job.turnId ?? stored.turnId ?? null;
  if (!threadId || !turnId) {
    throw new Error(
      `Job ${job.id} has not reported an active thread/turn yet. Wait for /codex:status ${job.id} to show a Codex session id, then retry.`
    );
  }

  return { workspaceRoot, job, threadId, turnId };
}

export async function steerJob(cwd, reference, message) {
  const text = validateSteerMessage(message);
  const { job, threadId, turnId } = resolveSteerableJob(cwd, reference);
  // Worktree jobs run (and register their broker) under their own cwd.
  const result = await steerAppServerTurn(job.runCwd ?? cwd, { threadId, turnId, text });

  return {
    jobId: job.id,
    threadId,
    expectedTurnId: turnId,
    steered: result.steered,
    transport: result.transport,
    detail: result.detail,
    softLimitExceeded: countWords(text) > STEER_SOFT_WORD_LIMIT
  };
}

export function renderSteerResult(payload) {
  const lines = [];
  if (payload.steered) {
    lines.push(`Steered job ${payload.jobId} (turn ${payload.expectedTurnId} on ${payload.threadId}).`);
    lines.push("The correction was queued into the active turn. Codex applies it at the next reasoning step.");
    lines.push(`Follow progress with /codex:status ${payload.jobId}.`);
  } else {
    lines.push(`Steering job ${payload.jobId} failed: ${payload.detail}`);
    lines.push(
      "If the turn already finished, use /codex:result and /codex:continue instead. If the correction is urgent, /codex:cancel and relaunch with a tighter brief."
    );
  }
  if (payload.softLimitExceeded) {
    lines.push(`Note: the steer message exceeded ${STEER_SOFT_WORD_LIMIT} words. Keep steering deltas short.`);
  }
  return `${lines.join("\n")}\n`;
}

// --- thread viewers -------------------------------------------------------

/**
 * Read-only viewer connection: reuse the session broker when one exists, but
 * never create a persistent broker just for a read. When the broker is busy
 * with an active stream, retry on a direct ephemeral app-server, which can
 * still read persisted rollout history.
 */
async function withReadClient(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const shouldRetryDirect = client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE;
    if (client) {
      await client.close().catch(() => {});
    }
    if (!shouldRetryDirect) {
      throw error;
    }
    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

function compactThread(thread) {
  return {
    id: thread.id,
    name: thread.name ?? null,
    preview: shorten(thread.preview, 80),
    cwd: thread.cwd ?? null,
    source: thread.source ?? null,
    updatedAt: formatTimestamp(thread.updatedAt),
    createdAt: formatTimestamp(thread.createdAt)
  };
}

function extractUserText(item) {
  if (Array.isArray(item.content)) {
    return item.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return item.text ?? "";
}

function compactItem(item, textLimit = 400) {
  const base = { type: item.type, id: item.id ?? null };
  switch (item.type) {
    case "userMessage":
      return { ...base, text: shorten(extractUserText(item), textLimit) };
    case "agentMessage":
      return { ...base, phase: item.phase ?? null, text: shorten(item.text, textLimit) };
    case "reasoning": {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.text ?? "").join(" ")
        : String(item.summary ?? "");
      return { ...base, summary: shorten(summary, textLimit) };
    }
    case "commandExecution":
      return {
        ...base,
        status: item.status ?? null,
        exitCode: item.exitCode ?? null,
        command: shorten(item.command, 160)
      };
    case "fileChange":
      return {
        ...base,
        status: item.status ?? null,
        paths: (item.changes ?? []).map((change) => change.path).filter(Boolean).slice(0, 20)
      };
    case "mcpToolCall":
      return { ...base, status: item.status ?? null, tool: `${item.server ?? "?"}/${item.tool ?? "?"}` };
    case "dynamicToolCall":
      return { ...base, status: item.status ?? null, tool: item.tool ?? null };
    case "collabAgentToolCall":
      return { ...base, status: item.status ?? null, tool: item.tool ?? null, subagents: item.receiverThreadIds ?? [] };
    case "webSearch":
      return { ...base, query: shorten(item.query, 120) };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { ...base, review: shorten(item.review, textLimit) };
    default:
      return base;
  }
}

function compactTurn(turn) {
  const items = turn.items ?? [];
  const itemCounts = {};
  for (const item of items) {
    itemCounts[item.type] = (itemCounts[item.type] ?? 0) + 1;
  }

  const firstUser = items.find((item) => item.type === "userMessage");
  const agentMessages = items.filter((item) => item.type === "agentMessage");
  const lastAgent = agentMessages.at(-1);

  return {
    id: turn.id,
    status: typeof turn.status === "string" ? turn.status : turn.status?.type ?? null,
    startedAt: formatTimestamp(turn.startedAt),
    durationMs: turn.durationMs ?? null,
    itemCounts,
    userText: firstUser ? shorten(extractUserText(firstUser), 100) : null,
    lastAgentText: lastAgent ? shorten(lastAgent.text, 100) : null,
    error: turn.error?.message ? shorten(turn.error.message, 160) : null
  };
}

export async function listThreadsCompact(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_THREADS_LIMIT, 50));

  return withReadClient(workspaceRoot, async (client) => {
    const response = await client.request("thread/list", {
      cursor: options.cursor ?? null,
      limit,
      sortKey: "updated_at",
      ...(options.all ? {} : { cwd: workspaceRoot }),
      ...(options.search ? { searchTerm: options.search } : {})
    });

    return {
      threads: (response.data ?? []).map(compactThread),
      nextCursor: response.nextCursor ?? null
    };
  });
}

export async function readThreadCompact(cwd, threadId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return withReadClient(workspaceRoot, async (client) => {
    const response = await client.request("thread/read", { threadId });
    return compactThread(response.thread);
  });
}

async function fetchTurnPages(client, threadId, { cursor = null, limit = TURNS_PAGE_SIZE, maxPages = 1 } = {}) {
  const turns = [];
  let nextCursor = cursor;
  let usedFallback = false;

  for (let page = 0; page < maxPages; page += 1) {
    let response;
    try {
      response = await client.request("thread/turns/list", {
        threadId,
        cursor: nextCursor,
        limit,
        sortDirection: "desc",
        itemsView: "full"
      });
    } catch (error) {
      if (!isMethodUnavailableError(error) || turns.length > 0) {
        throw error;
      }
      // Older Codex CLI versions lack thread/turns/list. Fall back to
      // thread/read and slice locally so output stays bounded even though the
      // wire payload is not.
      const read = await client.request("thread/read", { threadId, includeTurns: true });
      const allTurns = [...(read.thread.turns ?? [])].reverse();
      return { turns: allTurns, nextCursor: null, usedFallback: true };
    }

    turns.push(...(response.data ?? []));
    nextCursor = response.nextCursor ?? null;
    if (!nextCursor) {
      break;
    }
  }

  return { turns, nextCursor, usedFallback };
}

export async function listTurnsCompact(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_TURNS_LIMIT, 50));

  return withReadClient(workspaceRoot, async (client) => {
    const { turns, nextCursor, usedFallback } = await fetchTurnPages(client, options.threadId, {
      cursor: options.cursor ?? null,
      limit
    });

    return {
      threadId: options.threadId,
      turns: turns.slice(0, limit).map(compactTurn),
      nextCursor,
      usedFallback
    };
  });
}

export async function listItemsCompact(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_ITEMS_LIMIT, 100));
  const budgetChars = Math.max(500, Number(options.budgetChars) || DEFAULT_ITEMS_BUDGET_CHARS);
  const typeFilter = options.types?.length ? new Set(options.types) : null;

  return withReadClient(workspaceRoot, async (client) => {
    const { turns, usedFallback } = await fetchTurnPages(client, options.threadId, {
      maxPages: options.turnId ? MAX_TURN_PAGES_PER_SCAN : 1
    });

    let scopedTurns = turns;
    if (options.turnId) {
      scopedTurns = turns.filter((turn) => turn.id === options.turnId);
      if (scopedTurns.length === 0) {
        throw new Error(
          `Turn ${options.turnId} was not found in the ${turns.length} most recent turns of ${options.threadId}. Use /codex:turns ${options.threadId} to list turn ids.`
        );
      }
    }

    // Newest-first turn order, oldest-first items inside a turn: walk turns
    // from newest and keep the most recent `limit` matching items.
    const collected = [];
    let matchedTotal = 0;
    for (const turn of scopedTurns) {
      const turnItems = (turn.items ?? []).filter((item) => !typeFilter || typeFilter.has(item.type));
      matchedTotal += turnItems.length;
      if (collected.length < limit) {
        for (const item of turnItems.reverse()) {
          if (collected.length >= limit) {
            break;
          }
          collected.push({ turnId: turn.id, ...compactItem(item) });
        }
      }
    }

    let rendered = collected;
    let budgetTruncated = false;
    let totalChars = 0;
    const withinBudget = [];
    for (const item of rendered) {
      totalChars += JSON.stringify(item).length;
      if (totalChars > budgetChars) {
        budgetTruncated = true;
        break;
      }
      withinBudget.push(item);
    }
    rendered = withinBudget;

    return {
      threadId: options.threadId,
      turnId: options.turnId ?? null,
      items: rendered,
      matchedTotal,
      returned: rendered.length,
      budgetChars,
      budgetTruncated,
      usedFallback
    };
  });
}

export function renderThreadList(payload) {
  const lines = [];
  if (payload.threads.length === 0) {
    lines.push("No Codex threads found for this workspace. Use --all to include other directories.");
  }
  for (const thread of payload.threads) {
    const label = thread.name ? `${thread.name} — ` : "";
    lines.push(`${thread.id} | ${thread.updatedAt ?? "?"} | ${label}${thread.preview || "(no preview)"}`);
  }
  if (payload.nextCursor) {
    lines.push(`More threads available: rerun with --cursor ${payload.nextCursor}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderThreadSummary(thread) {
  const lines = [
    `Thread ${thread.id}`,
    `Name: ${thread.name ?? "(unnamed)"}`,
    `Preview: ${thread.preview || "(none)"}`,
    `Cwd: ${thread.cwd ?? "?"}`,
    `Updated: ${thread.updatedAt ?? "?"} (created ${thread.createdAt ?? "?"})`,
    `Inspect turns with /codex:turns ${thread.id}. Continue it with /codex:continue ${thread.id} <prompt>.`
  ];
  return `${lines.join("\n")}\n`;
}

export function renderTurnList(payload) {
  const lines = [`Turns for ${payload.threadId} (newest first):`];
  for (const turn of payload.turns) {
    const counts = Object.entries(turn.itemCounts)
      .map(([type, count]) => `${type}:${count}`)
      .join(" ");
    lines.push(`${turn.id} | ${turn.status ?? "?"} | ${turn.startedAt ?? "?"} | ${counts || "no items"}`);
    if (turn.userText) {
      lines.push(`  user: ${turn.userText}`);
    }
    if (turn.lastAgentText) {
      lines.push(`  agent: ${turn.lastAgentText}`);
    }
    if (turn.error) {
      lines.push(`  error: ${turn.error}`);
    }
  }
  if (payload.nextCursor) {
    lines.push(`More turns available: rerun with --cursor ${payload.nextCursor}`);
  }
  if (payload.usedFallback) {
    lines.push("(Served via thread/read fallback; this Codex CLI version lacks paginated turn listing.)");
  }
  return `${lines.join("\n")}\n`;
}

export function renderItemList(payload) {
  const lines = [
    `Items for ${payload.threadId}${payload.turnId ? ` turn ${payload.turnId}` : " (most recent turns)"}: showing ${payload.returned} of ${payload.matchedTotal} matched (newest first).`
  ];
  for (const item of payload.items) {
    const detail =
      item.text ?? item.summary ?? item.command ?? item.query ?? item.review ?? item.tool ?? (item.paths ? item.paths.join(", ") : "");
    const status = item.status ? ` [${item.status}${item.exitCode != null ? ` exit ${item.exitCode}` : ""}]` : "";
    lines.push(`${item.turnId} | ${item.type}${status} | ${detail}`);
  }
  if (payload.budgetTruncated) {
    lines.push(`Output truncated at ${payload.budgetChars} chars. Narrow with --turn/--type or raise --budget.`);
  }
  if (payload.usedFallback) {
    lines.push("(Served via thread/read fallback; this Codex CLI version lacks paginated turn listing.)");
  }
  return `${lines.join("\n")}\n`;
}

// --- tail -----------------------------------------------------------------

export function tailJobLog(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const job = reference
    ? jobs.find((candidate) => candidate.id === reference || candidate.id.startsWith(reference))
    : jobs.find((candidate) => candidate.status === "queued" || candidate.status === "running") ?? jobs[0];
  if (!job) {
    throw new Error(reference ? `No job found for "${reference}".` : "No Codex jobs found for this repository.");
  }

  const lineCount = Math.max(1, Math.min(Number(options.lines) || DEFAULT_TAIL_LINES, MAX_TAIL_LINES));
  const logFile = job.logFile ?? null;
  const allLines =
    logFile && fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean)
      : [];

  return {
    jobId: job.id,
    status: job.status,
    logFile,
    totalLines: allLines.length,
    lines: allLines.slice(-lineCount)
  };
}

export function renderTail(payload) {
  const lines = [`Last ${payload.lines.length} of ${payload.totalLines} log lines for ${payload.jobId} (${payload.status}):`];
  lines.push(...payload.lines);
  return `${lines.join("\n")}\n`;
}

// --- alerts ---------------------------------------------------------------

function parseLogTimestamp(line) {
  const match = /^\[([^\]]+)\]/.exec(line);
  if (!match) {
    return null;
  }
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildJobAlerts(job, options = {}) {
  const now = options.now ?? Date.now();
  const stallSeconds = Math.max(30, Number(options.stallSeconds) || DEFAULT_STALL_SECONDS);
  const alerts = [];

  const logLines =
    job.logFile && fs.existsSync(job.logFile)
      ? fs.readFileSync(job.logFile, "utf8").split(/\r?\n/).filter(Boolean)
      : [];

  if (job.status === "failed") {
    alerts.push({
      jobId: job.id,
      kind: "failed",
      evidence: shorten(job.errorMessage ?? "Job reported failure.", 160),
      suggestedAction: `Read /codex:result ${job.id}, then relaunch with a corrected brief.`
    });
    return alerts;
  }

  if (job.status !== "running" && job.status !== "queued") {
    return alerts;
  }

  const lastTimestamp = logLines.map(parseLogTimestamp).filter(Boolean).at(-1) ?? Date.parse(job.startedAt ?? job.createdAt ?? "");
  if (Number.isFinite(lastTimestamp) && now - lastTimestamp > stallSeconds * 1000) {
    alerts.push({
      jobId: job.id,
      kind: "stalled",
      evidence: `No progress events for ${Math.round((now - lastTimestamp) / 1000)}s (threshold ${stallSeconds}s).`,
      suggestedAction: `Check /codex:tail ${job.id}; if truly stuck, /codex:cancel ${job.id} and relaunch.`
    });
  }

  const failedCommands = logLines.filter((line) => /Command (?:failed|completed):.*\(exit (?!0\))\d+\)/.test(line));
  if (failedCommands.length >= REPEATED_FAILURE_THRESHOLD) {
    alerts.push({
      jobId: job.id,
      kind: "repeated-command-failures",
      evidence: `${failedCommands.length} failing commands, latest: ${shorten(failedCommands.at(-1), 140)}`,
      suggestedAction: `Steer with a narrower instruction (/codex:steer ${job.id} ...) or cancel and tighten the brief.`
    });
  }

  const errorLines = logLines.filter((line) => line.includes("Codex error:"));
  if (errorLines.length > 0) {
    alerts.push({
      jobId: job.id,
      kind: "codex-error",
      evidence: shorten(errorLines.at(-1), 160),
      suggestedAction: `Check /codex:status ${job.id}; the turn may fail shortly.`
    });
  }

  const startedAt = Date.parse(job.startedAt ?? job.createdAt ?? "");
  if (Number.isFinite(startedAt) && now - startedAt > LONG_RUNNING_SECONDS * 1000) {
    alerts.push({
      jobId: job.id,
      kind: "long-running",
      evidence: `Running for ${Math.round((now - startedAt) / 60000)} minutes.`,
      suggestedAction: `Confirm the scope is still right via /codex:tail ${job.id}; steer or cancel if it drifted.`
    });
  }

  return alerts;
}

export function buildAlertsSnapshot(cwd, reference = "", options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const scoped = reference
    ? jobs.filter((job) => job.id === reference || job.id.startsWith(reference))
    : jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "failed");

  if (reference && scoped.length === 0) {
    throw new Error(`No job found for "${reference}".`);
  }

  const alerts = scoped.flatMap((job) => buildJobAlerts(enrichJob(job), options));
  return {
    workspaceRoot,
    checkedJobs: scoped.map((job) => ({ id: job.id, status: job.status })),
    alerts
  };
}

export function renderAlerts(payload) {
  if (payload.alerts.length === 0) {
    const checked = payload.checkedJobs.map((job) => `${job.id} (${job.status})`).join(", ") || "none";
    return `No alerts. Jobs checked: ${checked}.\n`;
  }

  const lines = [];
  for (const alert of payload.alerts) {
    lines.push(`ALERT ${alert.jobId} ${alert.kind}`);
    lines.push(`  Evidence: ${alert.evidence}`);
    lines.push(`  Suggested action: ${alert.suggestedAction}`);
  }
  return `${lines.join("\n")}\n`;
}
