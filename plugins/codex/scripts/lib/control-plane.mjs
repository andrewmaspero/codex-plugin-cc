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
import path from "node:path";
import process from "node:process";

import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./app-server.mjs";
import { requestThreadGoal, steerAppServerTurn } from "./codex.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveJobFileGlobally, upsertJob } from "./state.mjs";
import { enrichJob, sortJobsNewestFirst } from "./job-control.mjs";
import { appendLogLine, SESSION_ID_ENV } from "./tracked-jobs.mjs";
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
const DEFAULT_STALL_SECONDS = 300;
const LONG_RUNNING_SECONDS = 30 * 60;
const REPEATED_FAILURE_THRESHOLD = 3;
const COMMAND_RESULT_WINDOW = 10;
const FAILED_ALERT_WINDOW_MS = 30 * 60 * 1000;
const GOAL_ALERT_STATUSES = new Set(["blocked", "usageLimited", "budgetLimited"]);

export const GOAL_OBJECTIVE_MAX_CHARS = 4000;
export const ARTIFACTS_DIR_NAME = ".codex-artifacts";

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
  let stored = null;
  let jobWorkspaceRoot = workspaceRoot;
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
      const globalMatch = resolveJobFileGlobally(workspaceRoot, reference);
      if (globalMatch) {
        stored = globalMatch.job;
        if (stored.status !== "queued" && stored.status !== "running") {
          throw new Error(
            `Job ${stored.id} is ${stored.status}, so there is no active turn to steer. Use /codex:continue ${stored.threadId ?? "<thread-id>"} for a follow-up turn instead.`
          );
        }
        job = stored;
        jobWorkspaceRoot = job.workspaceRoot ?? workspaceRoot;
      }
    }
    if (!job) {
      const finished = jobs.find((candidate) => candidate.id === reference || candidate.id.startsWith(reference));
      const globalFinished = stored && stored.status !== "queued" && stored.status !== "running" ? stored : null;
      if (finished || globalFinished) {
        const target = globalFinished ?? finished;
        throw new Error(
          `Job ${target.id} is ${target.status}, so there is no active turn to steer. Use /codex:continue ${target.threadId ?? "<thread-id>"} for a follow-up turn instead.`
        );
      }
      throw new Error(`No active job found for "${reference}". Run /codex:status to list jobs.`);
    }
  } else {
    const sessionId = process.env[SESSION_ID_ENV] ?? null;
    const sessionJobs = sessionId ? activeJobs.filter((candidate) => candidate.sessionId === sessionId) : activeJobs;
    if (sessionJobs.length === 0) {
      throw new Error(sessionId ? "No active Codex jobs to steer for this session." : "No active Codex jobs to steer.");
    }
    if (sessionJobs.length > 1) {
      throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:steer.");
    }
    job = sessionJobs[0];
  }

  stored = stored ?? (fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? readJobFile(resolveJobFile(workspaceRoot, job.id)) : {});
  const threadId = job.threadId ?? stored.threadId ?? null;
  const turnId = job.turnId ?? stored.turnId ?? null;
  if (!threadId || !turnId) {
    throw new Error(
      `Job ${job.id} has not reported an active thread/turn yet. Wait for /codex:status ${job.id} to show a Codex session id, then retry.`
    );
  }

  return { workspaceRoot: jobWorkspaceRoot, job, threadId, turnId };
}

export async function steerJob(cwd, reference, message) {
  const text = validateSteerMessage(message);
  const { workspaceRoot, job, threadId, turnId } = resolveSteerableJob(cwd, reference);
  // Worktree jobs run (and register their broker) under their own cwd; jobs
  // on a dedicated broker record its endpoint for direct targeting.
  const result = await steerAppServerTurn(job.runCwd ?? cwd, {
    threadId,
    turnId,
    text,
    brokerEndpoint: job.brokerEndpoint ?? null
  });

  if (result.steered) {
    appendLogLine(job.logFile, `Steered: ${shorten(text, 120)}`);
    upsertJob(workspaceRoot, { id: job.id, lastSteerAt: new Date().toISOString() });
  }

  return {
    jobId: job.id,
    jobStatus: job.status,
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
    if (payload.jobStatus === "running" || payload.jobStatus === "queued") {
      lines.push(
        "The job is still active, so its turn is likely running on an app-server this session's broker cannot reach (this happens when several jobs share one workspace). Run parallel jobs in worktrees (--worktree) to keep each steerable, or /codex:cancel and relaunch."
      );
    } else {
      lines.push(
        "If the turn already finished, use /codex:result and /codex:continue instead. If the correction is urgent, /codex:cancel and relaunch with a tighter brief."
      );
    }
  }
  if (payload.softLimitExceeded) {
    lines.push(`Note: the steer message exceeded ${STEER_SOFT_WORD_LIMIT} words. Keep steering deltas short.`);
  }
  return `${lines.join("\n")}\n`;
}

// --- goals ------------------------------------------------------------------

export function validateGoalObjective(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    throw new Error("Goal objective is empty. Provide the outcome and its checkable acceptance criteria.");
  }
  if (normalized.length > GOAL_OBJECTIVE_MAX_CHARS) {
    throw new Error(
      `Goal objective is too long (${normalized.length} chars, max ${GOAL_OBJECTIVE_MAX_CHARS}). Write the details to a file and set the objective to "Read the goal file at <path> before continuing. <one-line outcome>".`
    );
  }
  return normalized;
}

/**
 * Resolve a goal target from a tracked job id (exact or prefix, any status
 * with a thread) or, failing that, treat the reference as a thread id.
 * Without a reference, target the single active job for this session.
 */
export function resolveGoalTarget(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));

  if (!reference) {
    const sessionId = process.env[SESSION_ID_ENV] ?? null;
    const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
    const scoped = sessionId ? active.filter((job) => job.sessionId === sessionId) : active;
    if (scoped.length !== 1) {
      throw new Error(
        scoped.length === 0
          ? "No active Codex job found. Pass a job id or thread id."
          : "Multiple Codex jobs are active. Pass a job id or thread id."
      );
    }
    reference = scoped[0].id;
  }

  let job = jobs.find((candidate) => candidate.id === reference) ?? jobs.find((candidate) => candidate.id.startsWith(reference)) ?? null;
  if (!job && reference) {
    const globalMatch = resolveJobFileGlobally(workspaceRoot, reference);
    job = globalMatch?.job ?? null;
  }
  if (job) {
    if (!job.threadId) {
      throw new Error(`Job ${job.id} has not reported a Codex thread yet. Wait for /codex:status ${job.id} to show one.`);
    }
    return { threadId: job.threadId, connectCwd: job.runCwd ?? cwd, jobId: job.id, brokerEndpoint: job.brokerEndpoint ?? null };
  }

  return { threadId: reference, connectCwd: cwd, jobId: null, brokerEndpoint: null };
}

function compactGoal(goal) {
  if (!goal) {
    return null;
  }
  return {
    objective: shorten(goal.objective, 400),
    status: goal.status ?? null,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    updatedAt: formatTimestamp(goal.updatedAt)
  };
}

export async function setGoal(cwd, reference, objective, options = {}) {
  const normalized = validateGoalObjective(objective);
  const target = resolveGoalTarget(cwd, reference);
  const response = await requestThreadGoal(
    target.connectCwd,
    "thread/goal/set",
    {
      threadId: target.threadId,
      objective: normalized,
      status: options.status ?? "active",
      tokenBudget: options.tokenBudget ?? null
    },
    { brokerEndpoint: target.brokerEndpoint }
  );
  return {
    action: "set",
    ...target,
    ok: response.ok,
    goal: response.ok ? compactGoal(response.result.goal) : null,
    error: response.ok ? null : response.error
  };
}

export async function showGoal(cwd, reference) {
  const target = resolveGoalTarget(cwd, reference);
  const response = await requestThreadGoal(target.connectCwd, "thread/goal/get", { threadId: target.threadId }, { brokerEndpoint: target.brokerEndpoint });
  return {
    action: "show",
    ...target,
    ok: response.ok,
    goal: response.ok ? compactGoal(response.result.goal) : null,
    error: response.ok ? null : response.error
  };
}

export async function clearGoal(cwd, reference) {
  const target = resolveGoalTarget(cwd, reference);
  const response = await requestThreadGoal(target.connectCwd, "thread/goal/clear", { threadId: target.threadId }, { brokerEndpoint: target.brokerEndpoint });
  return {
    action: "clear",
    ...target,
    ok: response.ok,
    cleared: response.ok ? Boolean(response.result.cleared) : false,
    error: response.ok ? null : response.error
  };
}

export function renderGoalResult(payload) {
  const label = payload.jobId ? `job ${payload.jobId} (thread ${payload.threadId})` : `thread ${payload.threadId}`;
  if (!payload.ok) {
    return `Goal ${payload.action} failed for ${label}: ${payload.error}\n`;
  }

  if (payload.action === "clear") {
    return `${payload.cleared ? "Cleared the goal" : "No goal was set"} for ${label}.\n`;
  }

  if (!payload.goal) {
    return `No goal is set for ${label}. Set one with /codex:goal set ${payload.jobId ?? payload.threadId} -- <objective>.\n`;
  }

  const goal = payload.goal;
  const lines = [
    `Goal for ${label}: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${goal.tokensUsed} tokens${goal.tokenBudget ? ` of ${goal.tokenBudget} budget` : ""}, ${Math.round(goal.timeUsedSeconds / 60)}m elapsed (updated ${goal.updatedAt ?? "?"})`
  ];
  if (GOAL_ALERT_STATUSES.has(goal.status)) {
    lines.push(`The goal is ${goal.status}. Check /codex:tail, then steer, raise the budget, or replan.`);
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
      cursor: options.cursor ?? null,
      maxPages: options.turnId ? MAX_TURN_PAGES_PER_SCAN : 1
    });

    let scopedTurns = turns;
    if (options.turnId) {
      scopedTurns = turns.filter((turn) => turn.id === options.turnId || turn.id.startsWith(options.turnId));
      if (scopedTurns.length === 0) {
        throw new Error(
          `Turn ${options.turnId} was not found in the ${turns.length} most recent turns of ${options.threadId}. Use /codex:turns ${options.threadId} to list turn ids, or pass --cursor from its output to reach older turns.`
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
    lines.push(
      "No Codex threads matched this exact workspace directory. Threads started from subdirectories or worktrees have a different cwd — use --all to include everything."
    );
  }
  for (const thread of payload.threads) {
    const label = thread.name ? `${thread.name} — ` : "";
    lines.push(`${thread.id} | ${thread.updatedAt ?? "?"} | ${label}${thread.preview || "(no preview)"}`);
  }
  if (payload.nextCursor) {
    lines.push(`More threads available: rerun with --cursor '${payload.nextCursor}'`);
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
  const lines = [`Turns for ${payload.threadId} (newest first, ids shortened; prefixes work in --turn):`];
  for (const turn of payload.turns) {
    const counts = Object.entries(turn.itemCounts)
      .map(([type, count]) => `${type}:${count}`)
      .join(" ");
    lines.push(`${turn.id.slice(0, 13)} | ${turn.status ?? "?"} | ${turn.startedAt ?? "?"} | ${counts || "no items"}`);
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
    lines.push(`More turns available: rerun with --cursor '${payload.nextCursor}'`);
  }
  if (payload.usedFallback) {
    lines.push("(Served via thread/read fallback; this Codex CLI version lacks paginated turn listing, so --cursor is ignored.)");
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
    lines.push(`${item.turnId.slice(0, 13)} | ${item.type}${status} | ${detail}`);
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
  const globalMatch = reference ? resolveJobFileGlobally(workspaceRoot, reference) : null;
  const job = reference
    ? globalMatch?.job ?? jobs.find((candidate) => candidate.id === reference || candidate.id.startsWith(reference))
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

// --- artifacts --------------------------------------------------------------

function walkArtifactFiles(dir, baseDir, collected, limit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (collected.length >= limit) {
      return;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkArtifactFiles(fullPath, baseDir, collected, limit);
    } else if (entry.isFile()) {
      collected.push({
        path: fullPath,
        relativePath: path.relative(baseDir, fullPath),
        bytes: fs.statSync(fullPath).size
      });
    }
  }
}

/**
 * List the artifact directory for a job (`<runCwd>/.codex-artifacts/<job-id>/`).
 * Purely local; the brief convention tells Codex to save screenshots and
 * evidence there so the controller can Read individual files on demand.
 */
export function listJobArtifacts(cwd, reference = "", options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const globalMatch = reference ? resolveJobFileGlobally(workspaceRoot, reference) : null;
  const job = reference
    ? globalMatch?.job ?? jobs.find((candidate) => candidate.id === reference) ?? jobs.find((candidate) => candidate.id.startsWith(reference))
    : jobs[0];
  if (!job) {
    throw new Error(reference ? `No job found for "${reference}".` : "No Codex jobs found for this repository.");
  }

  const dir = path.join(job.runCwd ?? workspaceRoot, ARTIFACTS_DIR_NAME, job.id);
  const files = [];
  if (fs.existsSync(dir)) {
    walkArtifactFiles(dir, dir, files, Math.max(1, Number(options.limit) || 100));
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    jobId: job.id,
    dir,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0)
  };
}

export function renderArtifacts(payload) {
  if (payload.files.length === 0) {
    return `No artifacts for ${payload.jobId}. Briefs should tell Codex to save evidence under ${payload.dir}.\n`;
  }
  const lines = [`Artifacts for ${payload.jobId} in ${payload.dir} (${payload.files.length} files, ${Math.round(payload.totalBytes / 1024)} KB):`];
  for (const file of payload.files) {
    lines.push(`${file.relativePath} | ${file.bytes} bytes | ${file.path}`);
  }
  lines.push("Read only the files that matter; do not bulk-load them.");
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

function stripLogTimestamp(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "");
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM" ? true : false;
  }
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
    const completedAt = Date.parse(job.completedAt ?? job.updatedAt ?? "");
    if (!Number.isFinite(completedAt) || now - completedAt <= FAILED_ALERT_WINDOW_MS) {
      alerts.push({
        jobId: job.id,
        kind: "failed",
        evidence: shorten(job.errorMessage ?? "Job reported failure.", 160),
        suggestedAction: `Read /codex:result ${job.id}, then relaunch with a corrected brief.`
      });
    }
    return alerts;
  }

  if (job.status !== "running" && job.status !== "queued") {
    return alerts;
  }

  if (job.status === "running" && isProcessAlive(job.pid) === false) {
    alerts.push({
      jobId: job.id,
      kind: "orphaned",
      evidence: `Worker process ${job.pid} is no longer alive but the job is still marked running.`,
      suggestedAction: `/codex:cancel ${job.id} to mark it finished, then relaunch if the work is still needed.`
    });
  }

  // Only item start/complete events reach the log (message deltas are opted
  // out), so a long-running command or reasoning stretch is quiet. Anchor
  // everything on the timestamp prefix to avoid matching command text.
  const strippedLines = logLines.filter((line) => parseLogTimestamp(line) != null).map(stripLogTimestamp);
  const lastTimestamp = logLines.map(parseLogTimestamp).filter(Boolean).at(-1) ?? Date.parse(job.startedAt ?? job.createdAt ?? "");
  if (Number.isFinite(lastTimestamp) && now - lastTimestamp > stallSeconds * 1000) {
    const lastLine = strippedLines.at(-1) ?? "";
    const midCommand = lastLine.startsWith("Running command:");
    alerts.push({
      jobId: job.id,
      kind: "stalled",
      evidence: `No progress events for ${Math.round((now - lastTimestamp) / 1000)}s (threshold ${stallSeconds}s).${midCommand ? " Last event started a command, which may still be running." : ""}`,
      suggestedAction: midCommand
        ? `Check /codex:tail ${job.id}; a slow test/build may just be running. Cancel only if it clearly hung.`
        : `Check /codex:tail ${job.id}; if truly stuck, /codex:cancel ${job.id} and relaunch.`
    });
  }

  const commandResults = strippedLines
    .filter((line) => /^Command (?:failed|completed):/.test(line))
    .slice(-COMMAND_RESULT_WINDOW);
  const recentFailures = commandResults.filter((line) => {
    const exit = /\(exit (\d+)\)\s*$/.exec(line);
    return exit ? exit[1] !== "0" : /^Command failed:/.test(line);
  });
  const latestIsFailure = commandResults.length > 0 && recentFailures.at(-1) === commandResults.at(-1);
  if (recentFailures.length >= REPEATED_FAILURE_THRESHOLD && latestIsFailure) {
    alerts.push({
      jobId: job.id,
      kind: "repeated-command-failures",
      evidence: `${recentFailures.length} of the last ${commandResults.length} commands failed, latest: ${shorten(recentFailures.at(-1), 140)}`,
      suggestedAction: `Steer with a narrower instruction (/codex:steer ${job.id} ...) or cancel and tighten the brief.`
    });
  }

  const errorLines = strippedLines.filter((line) => line.startsWith("Codex error:"));
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

async function collectGoalAlerts(cwd, jobs) {
  const alerts = [];
  let checkErrors = 0;
  for (const job of jobs) {
    if ((job.status !== "running" && job.status !== "queued") || !job.threadId) {
      continue;
    }
    const response = await requestThreadGoal(job.runCwd ?? cwd, "thread/goal/get", { threadId: job.threadId }, { brokerEndpoint: job.brokerEndpoint ?? null });
    if (!response.ok) {
      checkErrors += 1;
      continue;
    }
    const goal = response.result.goal;
    if (goal && GOAL_ALERT_STATUSES.has(goal.status)) {
      alerts.push({
        jobId: job.id,
        kind: `goal-${goal.status}`,
        evidence: `Goal "${shorten(goal.objective, 100)}" is ${goal.status} (${goal.tokensUsed ?? 0} tokens used${goal.tokenBudget ? ` of ${goal.tokenBudget}` : ""}).`,
        suggestedAction:
          goal.status === "blocked"
            ? `Check /codex:tail ${job.id} for the blocker, then /codex:steer ${job.id} -- <unblock instruction>.`
            : `Raise the budget with /codex:goal set ${job.id} --budget <tokens> -- <same objective>, or wind the job down.`
      });
    }
  }
  return { alerts, checkErrors };
}

export async function buildAlertsSnapshot(cwd, reference = "", options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const scoped = reference
    ? jobs.filter((job) => job.id === reference || job.id.startsWith(reference))
    : jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "failed");

  if (reference && scoped.length === 0) {
    throw new Error(`No job found for "${reference}".`);
  }

  const alerts = scoped.flatMap((job) => buildJobAlerts(enrichJob(job), options));
  let goalCheckErrors = 0;
  if (options.checkGoals !== false) {
    const goalAlerts = await collectGoalAlerts(cwd, scoped);
    alerts.push(...goalAlerts.alerts);
    goalCheckErrors = goalAlerts.checkErrors;
  }

  return {
    workspaceRoot,
    checkedJobs: scoped.map((job) => ({ id: job.id, status: job.status })),
    alerts,
    goalCheckErrors
  };
}

export function renderAlerts(payload) {
  const lines = [];
  if (payload.alerts.length === 0) {
    const checked = payload.checkedJobs.map((job) => `${job.id} (${job.status})`).join(", ") || "none";
    lines.push(`No alerts. Jobs checked: ${checked}.`);
  }
  for (const alert of payload.alerts) {
    lines.push(`ALERT ${alert.jobId} ${alert.kind}`);
    lines.push(`  Evidence: ${alert.evidence}`);
    lines.push(`  Suggested action: ${alert.suggestedAction}`);
  }
  if (payload.goalCheckErrors > 0) {
    lines.push(`Note: ${payload.goalCheckErrors} goal check(s) could not reach their job runtime; goal drift may be underreported.`);
  }
  return `${lines.join("\n")}\n`;
}
