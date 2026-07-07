import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppServerNotification,
  AppServerResponse,
  ReviewTarget,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartParams,
  Turn,
  TurnStartParams,
  UserInput
} from "./app-server-protocol.d.ts";
import type { JsonValue } from "../../.generated/app-server-types/serde_json/JsonValue.js";

import { readJsonFile } from "./fs.mts";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mts";
import { clearBrokerSession, createDedicatedBrokerSession, loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "./broker-lifecycle.mts";
import { binaryAvailable, terminateProcessTree } from "./process.mts";

type ProgressUpdate =
  | string
  | {
      message: string;
      phase: string | null;
      threadId?: string | null;
      turnId?: string | null;
      stderrMessage?: string | null;
      logTitle?: string | null;
      logBody?: string | null;
    };
type ProgressReporter = (update: ProgressUpdate) => void;
type AppServerClientInstance = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;
type AppServerTransport = "shared" | "dedicated" | "direct" | "closed";
type StartRequestResponse = AppServerResponse<"review/start"> | AppServerResponse<"turn/start">;

interface ThreadOptions {
  model?: string | null;
  approvalPolicy?: ThreadStartParams["approvalPolicy"] | null;
  sandbox?: ThreadStartParams["sandbox"] | null;
  ephemeral?: boolean;
  threadName?: string | null;
}

interface ProgressExtra {
  threadId?: string | null;
  turnId?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
}

interface LogEventOptions extends ProgressExtra {
  message?: string | null;
  phase?: string | null;
}

interface RegisterThreadOptions {
  threadName?: string | null;
  name?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
}

interface CompleteTurnOptions {
  inferred?: boolean;
}

interface CaptureTurnOptions {
  onProgress?: ProgressReporter | null;
  idleReconcileMs?: number | string | null;
  onResponse?: (response: StartRequestResponse, state: TurnCaptureState) => void;
}

interface WithSteerableAppServerOptions {
  onEndpoint?: ((endpoint: string | null, transport: AppServerTransport) => void) | null;
}

interface AuthStatusFields {
  available?: boolean;
  loggedIn?: boolean;
  detail?: string;
  source?: string;
  authMethod?: string | null;
  verified?: boolean | null;
  requiresOpenaiAuth?: boolean | null;
  provider?: string | null;
}

interface CodexAuthStatusOptions {
  env?: NodeJS.ProcessEnv;
}

interface RunAppServerReviewOptions {
  onProgress?: ProgressReporter | null;
  model?: string | null;
  threadName?: string | null;
  delivery?: "inline" | "detached";
  target?: ReviewTarget | null;
}

interface ImportExternalAgentSessionOptions {
  sourcePath?: string;
  onProgress?: ProgressReporter | null;
}

interface RunAppServerTurnOptions {
  resumeThreadId?: string | null;
  model?: string | null;
  sandbox?: ThreadStartParams["sandbox"] | null;
  persistThread?: boolean;
  threadName?: string | null;
  goal?: { objective?: string | null; tokenBudget?: number | null } | null;
  prompt?: string | null;
  defaultPrompt?: string | null;
  effort?: string | null;
  outputSchema?: JsonValue;
  onProgress?: ProgressReporter | null;
  onRuntimeEndpoint?: ((endpoint: string | null, transport: AppServerTransport) => void) | null;
}

interface StructuredOutputFallback {
  failureMessage?: string;
  [key: string]: unknown;
}

interface TurnCaptureState {
  threadId: string;
  rootThreadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  threadLabels: Map<string, string>;
  turnId: string | null;
  rootTurnSource: "response" | "started" | "adopted" | null;
  bufferedNotifications: AppServerNotification[];
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (state: TurnCaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  reviewText: string;
  reasoningSummary: string[];
  error: unknown;
  messages: Array<{ lifecycle: string; phase: string | null; text: string }>;
  fileChanges: ThreadItem[];
  commandExecutions: ThreadItem[];
  onProgress: ProgressReporter | null;
}

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function buildThreadParams(cwd, options: ThreadOptions = {}): ThreadStartParams {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

function buildResumeParams(threadId, cwd, options: ThreadOptions = {}): ThreadResumeParams {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

function buildTurnInput(prompt): UserInput[] {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

// Maps the plugin's SandboxMode string to the structured per-turn SandboxPolicy.
// Auxiliary fields mirror the CLI's own SandboxPolicy::new_*_policy defaults
// (codex-rs/protocol/src/protocol.rs) so a turn override behaves identically to
// the same mode requested at thread start.
function buildTurnSandboxPolicy(sandbox, cwd = null): TurnStartParams["sandboxPolicy"] {
  switch (sandbox) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: cwd ? [cwd] : [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    default:
      return null;
  }
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra: ProgressExtra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options: LogEventOptions = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options: RegisterThreadOptions = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

function createTurnCaptureState(threadId: string, options: { onProgress?: ProgressReporter | null } = {}): TurnCaptureState {
  let resolveCompletion!: (state: TurnCaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The capture can be rejected (client exit) before the caller reaches its
  // await; keep a handled branch so that never surfaces as unhandledRejection.
  void completion.catch(() => {});

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    rootTurnSource: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options: CompleteTurnOptions = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

// How long to wait after an ADOPTED turn completes before finalizing: when a
// prompt is merged into an already-active turn, the app-server may instead
// requeue it as a brand-new turn that starts right after the active one
// completes. The grace window lets that follow-up turn re-latch the capture.
const ADOPTED_COMPLETION_GRACE_MS = 1500;

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  // An adopted turn may be the thread's own goal-continuation work rather
  // than a response to our input; require its real turn/completed (plus the
  // adoption grace window) instead of inferring completion from a final
  // answer that may predate our prompt.
  if (state.rootTurnSource === "adopted") {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function shouldBypassTurnCapture(message) {
  return typeof message?.method === "string" && message.method.startsWith("thread/goal/");
}

function isRootTurnStarted(state, message) {
  return message.method === "turn/started" && (message.params?.threadId ?? null) === state.threadId && message.params?.turn?.id;
}

function captureRootTurnStarted(state, message) {
  const nextTurnId = message.params.turn.id;
  // A pending adopted-turn completion is superseded by a real follow-up turn
  // (the app-server requeued our input as its own turn); keep capturing.
  clearCompletionTimer(state);
  if (state.turnId && state.turnId !== nextTurnId) {
    // A stale final answer from a previously tracked turn must not trigger
    // inferred completion of the new one.
    state.finalAnswerSeen = false;
  }
  state.turnId = nextTurnId;
  state.threadTurnIds.set(state.threadId, state.turnId);
  state.rootTurnSource = "started";
}

/**
 * The turn/start response's turn id is a submission id that does not always
 * match the id notifications carry. Worse, when the thread already has an
 * active turn (a goal-continuation turn the server started on its own), the
 * submitted input is merged into THAT turn and no turn with the response id
 * ever emits events. When root-thread turn events arrive for an id we do not
 * track and no tracked turn has materialized yet, adopt the live turn so the
 * job streams (and finishes with) the work that actually consumed its prompt.
 */
function shouldAdoptLiveRootTurn(state, message) {
  if (state.completed || state.rootTurnSource === "started" || state.rootTurnSource === "adopted") {
    return false;
  }
  if ((extractThreadId(message) ?? null) !== state.threadId) {
    return false;
  }
  if (!extractTurnId(message)) {
    return false;
  }
  return (
    message.method === "item/started" ||
    message.method === "item/updated" ||
    message.method === "item/completed" ||
    message.method === "turn/completed"
  );
}

function adoptLiveRootTurn(state, message) {
  const turnId = extractTurnId(message);
  state.turnId = turnId;
  state.threadTurnIds.set(state.threadId, turnId);
  state.rootTurnSource = "adopted";
  state.finalAnswerSeen = false;
  emitProgress(
    state.onProgress,
    `Adopted live turn ${turnId}: the thread was already running a turn, so this prompt was merged into it.`,
    "starting",
    { threadId: state.threadId, turnId }
  );
}

function scheduleAdoptedCompletion(state, turn) {
  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    completeTurn(state, turn);
  }, ADOPTED_COMPLETION_GRACE_MS);
  state.completionTimer.unref?.();
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      if (state.rootTurnSource === "adopted") {
        // The adopted turn may have absorbed our input (finalize with it) or
        // the server may requeue our input as a fresh turn immediately after
        // it; wait a short grace window for that follow-up turn/started.
        emitProgress(
          state.onProgress,
          `Adopted turn ${message.params.turn.status}; finalizing unless a follow-up turn starts.`,
          "finalizing"
        );
        scheduleAdoptedCompletion(state, message.params.turn);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

const DEFAULT_IDLE_RECONCILE_MS = 60000;
const IDLE_RECONCILE_ENV = "CODEX_COMPANION_IDLE_RECONCILE_MS";
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

function resolveIdleReconcileMs(options: CaptureTurnOptions = {}) {
  const fromEnv = Number(process.env[IDLE_RECONCILE_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  const fromOptions = Number(options.idleReconcileMs);
  if (Number.isFinite(fromOptions) && fromOptions >= 0) {
    return fromOptions;
  }
  return DEFAULT_IDLE_RECONCILE_MS;
}

function extractTurnStatus(turn) {
  return typeof turn?.status === "string" ? turn.status : turn?.status?.type ?? null;
}

/**
 * Reconciliation fallback for an alive-but-starved worker: if no notification
 * arrives for `idleMs`, poll the thread's latest turn. When it is terminal,
 * synthesize the completion (result = its last agentMessage) instead of
 * waiting forever on an event stream that silently dropped the turn/completed
 * (observed in the field: job hung for an hour while the turn had finished).
 */
function startIdleReconciler(client, state, idleMs, getLastEventAt) {
  if (!idleMs) {
    return null;
  }
  let inFlight = false;
  const timer = setInterval(async () => {
    if (state.completed || inFlight || Date.now() - getLastEventAt() < idleMs) {
      return;
    }
    inFlight = true;
    try {
      const response = await client.request("thread/turns/list", {
        threadId: state.threadId,
        cursor: null,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full"
      });
      if (state.completed) {
        return;
      }
      const latest = response?.data?.[0] ?? null;
      const status = extractTurnStatus(latest);
      if (!latest || !TERMINAL_TURN_STATUSES.has(status)) {
        return;
      }
      const lastAgent = [...(latest.items ?? [])].reverse().find((item) => item?.type === "agentMessage" && item.text);
      if (lastAgent) {
        state.lastAgentMessage = lastAgent.text;
        state.messages.push({ lifecycle: "completed", phase: lastAgent.phase ?? null, text: lastAgent.text });
      }
      emitProgress(
        state.onProgress,
        `Turn completion reconciled from thread state: no events for ${Math.round((Date.now() - getLastEventAt()) / 1000)}s while the latest turn (${latest.id}) is ${status}.`,
        "finalizing"
      );
      completeTurn(state, { id: latest.id, status });
    } catch {
      // Broker busy, unsupported method, or transient failure: retry next tick.
    } finally {
      inFlight = false;
    }
  }, Math.max(250, Math.min(idleMs, 20000)));
  timer.unref?.();
  return timer;
}

async function captureTurn(
  client: AppServerClientInstance,
  threadId,
  startRequest: () => Promise<StartRequestResponse>,
  options: CaptureTurnOptions = {}
) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  let lastEventAt = Date.now();
  const idleReconciler = startIdleReconciler(client, state, resolveIdleReconcileMs(options), () => lastEventAt);

  // If the app-server connection dies mid-turn (broker shutdown/replacement,
  // app-server crash), the completion promise would never settle and — with
  // every timer unref'd — the worker's event loop would drain and the process
  // would exit 0 silently, leaving the job "running" forever (OBS-B). Reject
  // the capture instead so the job records a precise failure.
  client.exitPromise.then(() => {
    if (state.completed) {
      return;
    }
    state.completed = true;
    clearCompletionTimer(state);
    const cause = client.exitError;
    emitProgress(
      state.onProgress,
      `Codex runtime connection closed before the turn completed${cause?.message ? `: ${shorten(cause.message, 160)}` : "."}`,
      "failed"
    );
    state.rejectCompletion(
      cause ?? new Error("The Codex runtime connection closed before the turn completed (broker or app-server went away).")
    );
  });

  client.setNotificationHandler((message) => {
    lastEventAt = Date.now();
    if (shouldBypassTurnCapture(message)) {
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    if (!state.turnId) {
      if (isRootTurnStarted(state, message)) {
        captureRootTurnStarted(state, message);
        applyTurnNotification(state, message);
        return;
      }
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (isRootTurnStarted(state, message)) {
      captureRootTurnStarted(state, message);
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      if (shouldAdoptLiveRootTurn(state, message)) {
        adoptLiveRootTurn(state, message);
        applyTurnNotification(state, message);
        return;
      }
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    applyTurnNotification(state, message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    const responseTurnId = response.turn?.id ?? null;
    // A root turn/started that arrived before the response is authoritative:
    // the response's turn id is a submission id that may never appear in
    // notifications, so it must not clobber an id observed on the wire.
    if (responseTurnId && state.rootTurnSource !== "started" && state.rootTurnSource !== "adopted") {
      state.turnId = responseTurnId;
      state.threadTurnIds.set(state.threadId, responseTurnId);
      state.rootTurnSource = "response";
    }
    for (const message of state.bufferedNotifications) {
      if (shouldBypassTurnCapture(message)) {
        if (previousHandler) {
          previousHandler(message);
        }
      } else if (message.method === "thread/started" || message.method === "thread/name/updated") {
        // Same special case as the live handler path: subagent thread
        // announcements (names) can arrive before the turn/start response
        // resolves, and dropping them here loses subagent labels for the
        // whole turn ("Subagent thr_2" instead of its name — deterministic
        // on slow CI runners, rare on fast machines).
        applyTurnNotification(state, message);
      } else if (isRootTurnStarted(state, message)) {
        captureRootTurnStarted(state, message);
        applyTurnNotification(state, message);
      } else if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else if (shouldAdoptLiveRootTurn(state, message)) {
        adoptLiveRootTurn(state, message);
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    if (idleReconciler) {
      clearInterval(idleReconciler);
    }
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

export async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
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

/**
 * Like withAppServer, but keeps the turn steerable when the shared broker is
 * busy: instead of degrading to an in-process direct app-server (which no
 * external control connection can reach), spawn a dedicated broker for this
 * job and report its endpoint through onEndpoint so steer/goal/cancel can
 * target it. The dedicated broker is torn down when the run finishes.
 */
async function withSteerableAppServer<T>(
  cwd,
  fn: (client: AppServerClientInstance) => Promise<T>,
  options: WithSteerableAppServerOptions = {}
): Promise<T> {
  const onEndpoint = options.onEndpoint ?? null;
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    if (client.transport === "broker") {
      onEndpoint?.(process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null, "shared");
    } else {
      onEndpoint?.(null, "direct");
    }
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetry =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetry) {
      throw error;
    }

    const session = await createDedicatedBrokerSession(cwd, { killProcess: terminateProcessTree });
    if (!session) {
      onEndpoint?.(null, "direct");
      const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
      try {
        return await fn(directClient);
      } finally {
        await directClient.close();
      }
    }

    onEndpoint?.(session.endpoint, "dedicated");
    try {
      const dedicatedClient = await CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint });
      try {
        return await fn(dedicatedClient);
      } finally {
        await dedicatedClient.close();
      }
    } finally {
      await sendBrokerShutdown(session.endpoint).catch(() => {});
      teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
      onEndpoint?.(null, "closed");
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client: AppServerClientInstance, cwd, options: ThreadOptions = {}): Promise<AppServerResponse<"thread/start">> {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client: AppServerClientInstance, threadId, cwd, options: ThreadOptions = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields: AuthStatusFields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options: CodexAuthStatusOptions = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId, brokerEndpoint = null }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      reuseExistingBroker: true,
      ...(brokerEndpoint ? { brokerEndpoint } : {})
    });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function steerAppServerTurn(cwd, { threadId, turnId, text, brokerEndpoint = null }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      steered: false,
      turnId: null,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      steered: false,
      turnId: null,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      reuseExistingBroker: true,
      ...(brokerEndpoint ? { brokerEndpoint } : {})
    });
    // The broker lets turn/steer through during an active stream, but a
    // transient in-flight request on the stream socket can still surface
    // busy; retry briefly before giving up.
    let response = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await client.request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: buildTurnInput(text)
        });
        break;
      } catch (error) {
        if (error?.rpcCode !== BROKER_BUSY_RPC_CODE || attempt >= 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return {
      attempted: true,
      steered: true,
      turnId: response.turnId ?? turnId,
      transport: client.transport,
      detail: `Steered turn ${response.turnId ?? turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      steered: false,
      turnId: null,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Run one thread/goal/* request against the app-server instance reachable
 * from `cwd` (existing broker when present, ephemeral direct otherwise).
 * Goal methods pass the broker's control bypass, so they work while a
 * background turn is streaming.
 */
export async function requestThreadGoal(cwd, method, params, { brokerEndpoint = null } = {}) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      reuseExistingBroker: true,
      ...(brokerEndpoint ? { brokerEndpoint } : {})
    });
    const result = await client.request(method, params);
    return { ok: true, transport: client.transport, result };
  } catch (error) {
    return {
      ok: false,
      transport: client?.transport ?? null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options: RunAppServerReviewOptions = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if ("reviewThreadId" in response && response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options: ImportExternalAgentSessionOptions = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

/**
 * Shut down and forget the shared broker session registered for `cwd`.
 * Worktree jobs register a broker keyed to the worktree; without this the
 * broker (and its codex app-server) outlives the job and the worktree.
 */
export async function teardownWorkspaceBrokerSession(cwd) {
  const session = loadBrokerSession(cwd);
  if (!session) {
    return false;
  }
  await sendBrokerShutdown(session.endpoint).catch(() => {});
  teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
  clearBrokerSession(cwd);
  return true;
}

export async function runAppServerTurn(cwd, options: RunAppServerTurnOptions = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withSteerableAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    if (options.goal?.objective) {
      try {
        await client.request("thread/goal/set", {
          threadId,
          objective: options.goal.objective,
          status: "active",
          tokenBudget: options.goal.tokenBudget ?? null
        });
      } catch (error) {
        const message = String(error?.message ?? error ?? "");
        if (error?.rpcCode === -32601 || message.includes("unknown variant") || message.includes("unknown method")) {
          throw new Error(
            "This Codex CLI does not support thread goals. Rerun without --goal, or upgrade with `npm install -g @openai/codex@latest`.",
            { cause: error }
          );
        }
        throw error;
      }
      emitProgress(options.onProgress, `Goal set: ${shorten(options.goal.objective, 96)}`, "starting");
    }

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          // thread/resume silently ignores sandbox/approval overrides when the
          // thread is already loaded in the app-server (it only logs a warning);
          // the per-turn override is honored unconditionally, so send it on
          // every turn to make the job's sandbox deterministic.
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: buildTurnSandboxPolicy(options.sandbox, cwd),
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  }, { onEndpoint: options.onRuntimeEndpoint });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback: StructuredOutputFallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
