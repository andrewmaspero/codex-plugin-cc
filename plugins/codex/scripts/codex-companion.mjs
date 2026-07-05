#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    teardownWorkspaceBrokerSession
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { sendBrokerShutdown } from "./lib/broker-lifecycle.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, createCodexWorktree, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  buildAlertsSnapshot,
  clearGoal,
  listItemsCompact,
  listJobArtifacts,
  listThreadsCompact,
  listTurnsCompact,
  readThreadCompact,
  renderAlerts,
  renderArtifacts,
  renderGoalResult,
  renderItemList,
  renderSteerResult,
  renderTail,
  renderThreadList,
  renderThreadSummary,
  renderTurnList,
  setGoal,
  showGoal,
  steerJob,
  tailJobLog,
  validateGoalObjective
} from "./lib/control-plane.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const SANDBOX_ALIASES = new Map([
  ["read-only", "read-only"],
  ["readonly", "read-only"],
  ["workspace-write", "workspace-write"],
  ["write", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
  ["full", "danger-full-access"],
  ["danger", "danger-full-access"]
]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--sandbox <read-only|write|full|clear>] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write|--full|--sandbox <mode>] [--worktree|--worktree-name <name>] [--goal <objective>] [--goal-budget <tokens>] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--full|--max-chars <n>] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  node scripts/codex-companion.mjs steer <job-id> -- <short corrective instruction>",
      "  node scripts/codex-companion.mjs threads [--limit <n>] [--cursor <cursor>] [--search <term>] [--all] [--json]",
      "  node scripts/codex-companion.mjs thread <thread-id> [--json]",
      "  node scripts/codex-companion.mjs turns <thread-id> [--limit <n>] [--cursor <cursor>] [--json]",
      "  node scripts/codex-companion.mjs items <thread-id> [--turn <turn-id>] [--type <t1,t2>] [--limit <n>] [--cursor <cursor>] [--budget <chars>] [--json]",
      "  node scripts/codex-companion.mjs tail [job-id] [--lines <n>] [--json]",
      "  node scripts/codex-companion.mjs alerts [job-id] [--stall-seconds <n>] [--no-goals] [--json]",
      "  node scripts/codex-companion.mjs goal <set|show|clear> [job-id|thread-id] [--budget <tokens>] [--status <status>] [-- <objective>]",
      "  node scripts/codex-companion.mjs artifacts [job-id] [--limit <n>] [--json]",
      "  node scripts/codex-companion.mjs continue <thread-id> [--background] [--write|--full|--sandbox <mode>] [--worktree|--worktree-name <name>] [--goal <objective>] [--goal-budget <tokens>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeSandboxMode(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const mode = SANDBOX_ALIASES.get(normalized);
  if (!mode) {
    throw new Error(
      `Unsupported sandbox mode "${value}". Use one of: read-only, workspace-write (write), danger-full-access (full).`
    );
  }
  return mode;
}

/**
 * Sandbox resolution order: explicit --sandbox, then --full, then --write,
 * then the workspace's configured defaultSandbox (set via
 * `setup --sandbox <mode>`), then read-only.
 */
function resolveTaskSandbox(options, workspaceRoot) {
  const explicit = normalizeSandboxMode(options.sandbox);
  if (explicit) {
    return explicit;
  }
  if (options.full) {
    return "danger-full-access";
  }
  if (options.write) {
    return "workspace-write";
  }
  const configured = normalizeSandboxMode(getConfig(workspaceRoot).defaultSandbox);
  return configured ?? "read-only";
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    defaultSandbox: normalizeSandboxMode(config.defaultSandbox) ?? "read-only",
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "sandbox"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (options.sandbox) {
    const requested = String(options.sandbox).trim().toLowerCase();
    if (requested === "clear" || requested === "default") {
      setConfig(workspaceRoot, "defaultSandbox", null);
      actionsTaken.push(`Cleared the default sandbox for ${workspaceRoot} (tasks run read-only unless flagged).`);
    } else {
      const mode = normalizeSandboxMode(options.sandbox);
      setConfig(workspaceRoot, "defaultSandbox", mode);
      actionsTaken.push(`Set the default sandbox for ${workspaceRoot} to ${mode}. All rescue/continue jobs now run with it unless overridden per call.`);
    }
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const reviewStateRoot = request.workspaceRoot ?? resolveWorkspaceRoot(request.cwd);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onRuntimeEndpoint: request.jobId
      ? (endpoint, transport) => {
          try {
            upsertJob(reviewStateRoot, { id: request.jobId, brokerEndpoint: endpoint, brokerTransport: transport });
          } catch {
            // Never let bookkeeping kill the run.
          }
        }
      : null,
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  // Record which runtime the turn actually streams through, so steer/goal/
  // cancel can reach it even when this job fell back to a dedicated broker.
  const jobStateRoot = request.workspaceRoot ?? workspaceRoot;
  const onRuntimeEndpoint = request.jobId
    ? (endpoint, transport) => {
        try {
          upsertJob(jobStateRoot, { id: request.jobId, brokerEndpoint: endpoint, brokerTransport: transport });
        } catch {
          // Never let bookkeeping kill the run.
        }
      }
    : null;

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    resumeThreadId: request.resumeThreadId ?? null
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  let result;
  try {
    result = await runAppServerTurn(workspaceRoot, {
      resumeThreadId,
      prompt: request.prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model: request.model,
      effort: request.effort,
      sandbox: request.sandbox ?? (request.write ? "workspace-write" : "read-only"),
      goal: request.goal ?? null,
      onRuntimeEndpoint,
      onProgress: request.onProgress,
      persistThread: true,
      threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
    });
  } finally {
    if (request.worktree?.worktreePath) {
      // The worktree job registered a broker keyed to the worktree; reap it
      // so no broker/app-server outlives the job.
      await teardownWorkspaceBrokerSession(workspaceRoot).catch(() => {});
      onRuntimeEndpoint?.(null, "closed");
    }
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  let rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  if (request.worktree?.worktreePath) {
    rendered = `${rendered.trimEnd()}\n\nWorktree: ${request.worktree.worktreePath} (branch ${request.worktree.branch}). Merge it back or clean up with \`git worktree remove ${request.worktree.worktreePath}\`.\n`;
  }
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    sandbox: request.sandbox ?? (request.write ? "workspace-write" : "read-only"),
    worktree: request.worktree ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, resumeThreadId = null }) {
  if (!resumeLast && !resumeThreadId && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  if (resumeThreadId) {
    return {
      title: "Codex Continue",
      summary: shorten(prompt || `Continue ${resumeThreadId}`)
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  const lines = [`${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.`];
  if (payload.worktree?.worktreePath) {
    lines.push(`Worktree: ${payload.worktree.worktreePath} (branch ${payload.worktree.branch}).`);
  }
  if (payload.sandbox && payload.sandbox !== "read-only") {
    lines.push(`Sandbox: ${payload.sandbox}.`);
  }
  return `${lines.join("\n")}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, execution = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write: Boolean(execution.write),
    ...(execution.sandbox ? { sandbox: execution.sandbox } : {})
  });
}

/**
 * When the caller asked for worktree isolation, create the worktree and pin
 * the job's execution cwd (`runCwd`) to it. Job state stays in the original
 * workspace; steer/cancel use `runCwd` to find the job's broker.
 */
function setupJobWorktree(cwd, job, options) {
  if (!options.worktree && !options["worktree-name"]) {
    return { job, runCwd: cwd, worktree: null };
  }
  const created = createCodexWorktree(cwd, options["worktree-name"] ?? job.id);
  const worktree = { worktreePath: created.worktreePath, branch: created.branch };
  return {
    job: { ...job, runCwd: created.worktreePath, worktree },
    runCwd: created.worktreePath,
    worktree
  };
}

function buildTaskRequest({ cwd, workspaceRoot = null, model, effort, prompt, write, sandbox = null, worktree = null, goal = null, resumeLast, resumeThreadId = null, jobId }) {
  return {
    cwd,
    workspaceRoot,
    model,
    effort,
    prompt,
    write,
    sandbox,
    worktree,
    goal,
    resumeLast,
    resumeThreadId,
    jobId
  };
}

function resolveGoalOption(options) {
  if (!options.goal) {
    return null;
  }
  return {
    objective: validateGoalObjective(options.goal),
    tokenBudget: options["goal-budget"] != null ? Number(options["goal-budget"]) : null
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      sandbox: job.sandbox ?? null,
      worktree: job.worktree ?? null,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        workspaceRoot,
        jobId: job.id,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "worktree-name", "goal", "goal-budget"],
    booleanOptions: ["json", "write", "full", "worktree", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  requireTaskRequest(prompt, resumeLast);
  const sandbox = resolveTaskSandbox(options, workspaceRoot);
  const write = sandbox !== "read-only";
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  let job = buildTaskJob(workspaceRoot, taskMetadata, { write, sandbox });
  const worktreeSetup = setupJobWorktree(cwd, job, options);
  job = worktreeSetup.job;
  const request = buildTaskRequest({
    cwd: worktreeSetup.runCwd,
    workspaceRoot,
    model,
    effort,
    prompt,
    write,
    sandbox,
    worktree: worktreeSetup.worktree,
    goal: resolveGoalOption(options),
    resumeLast,
    jobId: job.id
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

const DEFAULT_RESULT_MAX_CHARS = 8000;

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "max-chars"],
    booleanOptions: ["json", "full"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  let rendered = renderStoredJobResult(job, storedJob);
  const maxChars = options.full ? Infinity : Math.max(500, Number(options["max-chars"]) || DEFAULT_RESULT_MAX_CHARS);
  if (rendered.length > maxChars) {
    rendered = `${rendered.slice(0, maxChars).trimEnd()}\n\n[Output truncated at ${maxChars} chars of ${rendered.length}. Rerun with --full for everything${job.logFile ? `, or read the job log at ${job.logFile}` : ""}.]\n`;
  }

  outputCommandResult(payload, rendered, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  // Worktree jobs run (and register their broker) under their own cwd; jobs
  // that fell back to a dedicated broker record its endpoint.
  const brokerEndpoint = existing.brokerEndpoint ?? job.brokerEndpoint ?? null;
  const interrupt = await interruptAppServerTurn(existing.runCwd ?? job.runCwd ?? cwd, { threadId, turnId, brokerEndpoint });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  if ((existing.brokerTransport ?? job.brokerTransport) === "dedicated" && brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint).catch(() => {});
  }
  const cancelRunCwd = existing.runCwd ?? job.runCwd ?? null;
  if ((existing.worktree ?? job.worktree) && cancelRunCwd) {
    await teardownWorkspaceBrokerSession(cancelRunCwd).catch(() => {});
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function handleSteer(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const [reference, ...messageParts] = positionals;
  const payload = await steerJob(cwd, reference ?? "", messageParts.join(" "));
  outputCommandResult(payload, renderSteerResult(payload), options.json);
  if (!payload.steered) {
    process.exitCode = 1;
  }
}

async function handleThreads(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "limit", "cursor", "search"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const payload = await listThreadsCompact(cwd, {
    limit: options.limit,
    cursor: options.cursor,
    search: options.search,
    all: Boolean(options.all)
  });
  outputCommandResult(payload, renderThreadList(payload), options.json);
}

async function handleThread(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const threadId = positionals[0];
  if (!threadId) {
    throw new Error("Usage: thread <thread-id>. Run `threads` to list thread ids.");
  }

  const cwd = resolveCommandCwd(options);
  const payload = await readThreadCompact(cwd, threadId);
  outputCommandResult(payload, renderThreadSummary(payload), options.json);
}

async function handleTurns(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "limit", "cursor"],
    booleanOptions: ["json"]
  });

  const threadId = positionals[0];
  if (!threadId) {
    throw new Error("Usage: turns <thread-id> [--limit <n>] [--cursor <cursor>].");
  }

  const cwd = resolveCommandCwd(options);
  const payload = await listTurnsCompact(cwd, {
    threadId,
    limit: options.limit,
    cursor: options.cursor
  });
  outputCommandResult(payload, renderTurnList(payload), options.json);
}

async function handleItems(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "turn", "type", "limit", "cursor", "budget"],
    booleanOptions: ["json"]
  });

  const threadId = positionals[0];
  if (!threadId) {
    throw new Error("Usage: items <thread-id> [--turn <turn-id>] [--type <t1,t2>] [--limit <n>] [--budget <chars>].");
  }

  const cwd = resolveCommandCwd(options);
  const payload = await listItemsCompact(cwd, {
    threadId,
    turnId: options.turn ?? null,
    types: options.type
      ? String(options.type)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : null,
    limit: options.limit,
    cursor: options.cursor ?? null,
    budgetChars: options.budget
  });
  outputCommandResult(payload, renderItemList(payload), options.json);
}

function handleTail(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "lines"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const payload = tailJobLog(cwd, positionals[0] ?? "", { lines: options.lines });
  outputCommandResult(payload, renderTail(payload), options.json);
}

async function handleAlerts(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "stall-seconds"],
    booleanOptions: ["json", "no-goals"]
  });

  const cwd = resolveCommandCwd(options);
  const payload = await buildAlertsSnapshot(cwd, positionals[0] ?? "", {
    stallSeconds: options["stall-seconds"],
    checkGoals: !options["no-goals"]
  });
  outputCommandResult(payload, renderAlerts(payload), options.json);
}

async function handleGoal(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "budget", "status"],
    booleanOptions: ["json"]
  });

  const [action, ...rest] = positionals;
  const cwd = resolveCommandCwd(options);

  if (action === "set") {
    const [reference, ...objectiveParts] = rest;
    const payload = await setGoal(cwd, reference ?? "", objectiveParts.join(" "), {
      tokenBudget: options.budget != null ? Number(options.budget) : null,
      status: options.status ?? "active"
    });
    outputCommandResult(payload, renderGoalResult(payload), options.json);
    if (!payload.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (action === "show" || action === "clear") {
    const reference = rest[0] ?? "";
    const payload = action === "show" ? await showGoal(cwd, reference) : await clearGoal(cwd, reference);
    outputCommandResult(payload, renderGoalResult(payload), options.json);
    if (!payload.ok) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error("Usage: goal <set|show|clear> [job-id|thread-id] [--budget <tokens>] [--status <status>] [-- <objective>]");
}

function handleArtifacts(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "limit"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const payload = listJobArtifacts(cwd, positionals[0] ?? "", { limit: options.limit });
  outputCommandResult(payload, renderArtifacts(payload), options.json);
}

async function handleContinue(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "sandbox", "worktree-name", "goal", "goal-budget"],
    booleanOptions: ["json", "write", "full", "worktree", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const [threadId, ...promptParts] = positionals;
  if (!threadId) {
    throw new Error("Usage: continue <thread-id> [prompt]. Run `threads` to list thread ids.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = promptParts.join(" ").trim();
  const sandbox = resolveTaskSandbox(options, workspaceRoot);
  const write = sandbox !== "read-only";

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeThreadId: threadId });
  let job = buildTaskJob(workspaceRoot, taskMetadata, { write, sandbox });
  const worktreeSetup = setupJobWorktree(cwd, job, options);
  job = worktreeSetup.job;
  const request = buildTaskRequest({
    cwd: worktreeSetup.runCwd,
    workspaceRoot,
    model,
    effort,
    prompt,
    write,
    sandbox,
    worktree: worktreeSetup.worktree,
    goal: resolveGoalOption(options),
    resumeLast: false,
    resumeThreadId: threadId,
    jobId: job.id
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "steer":
      await handleSteer(argv);
      break;
    case "threads":
      await handleThreads(argv);
      break;
    case "thread":
      await handleThread(argv);
      break;
    case "turns":
      await handleTurns(argv);
      break;
    case "items":
      await handleItems(argv);
      break;
    case "tail":
      handleTail(argv);
      break;
    case "alerts":
      await handleAlerts(argv);
      break;
    case "goal":
      await handleGoal(argv);
      break;
    case "artifacts":
      handleArtifacts(argv);
      break;
    case "continue":
      await handleContinue(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
