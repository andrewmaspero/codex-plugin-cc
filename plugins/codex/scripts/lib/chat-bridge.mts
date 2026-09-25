/**
 * Read-only chat bridge: list, search, and read Codex chats and Claude Code
 * chats, and list running codex-fable jobs. Backs scripts/chat-bridge-mcp.mts.
 *
 * Everything here is read-only. Codex thread metadata and items come from a
 * direct, ephemeral `codex app-server` (never the persistent broker, never a
 * turn), so no model credits are spent. Full-text search streams rollout and
 * transcript files line by line. Every output is bounded by a char budget and
 * passed through secret redaction; only ids and paths under the known roots
 * are accepted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { CodexAppServerClient } from "./app-server.mts";
import { compactItem, isMethodUnavailableError } from "./control-plane.mts";
import { isProcessAlive } from "./process.mts";

export const DEFAULT_BUDGET_CHARS = 4000;
export const MAX_BUDGET_CHARS = 20000;
const MIN_BUDGET_CHARS = 500;
const NOTICE_RESERVE_CHARS = 300;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_READ_LIMIT = 20;
export const MAX_READ_LIMIT = 100;

const DEFAULT_SEARCH_TIME_MS = 20_000;
const DEFAULT_APP_SERVER_TIMEOUT_MS = 30_000;
const SNIPPET_CHARS = 200;
const MAX_MATCHES_PER_CHAT = 3;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 32 * 1024;
const MULTI_ITEM_TEXT_CHARS = 400;
const MAX_TURN_PAGES = 10;

const PLUGIN_DATA_DIR_NAMES = ["codex-codex-fable", "codex-inline"];
const INTERACTIVE_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const SUBAGENT_SOURCE_KINDS = ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"];

const FORBIDDEN_BASENAMES = new Set([
  "auth.json",
  ".credentials.json",
  "credentials.json",
  "config.toml",
  ".env"
]);

const CODEX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type ChatSource = "codex" | "claude";
export type ChatSourceFilter = ChatSource | "all";

export interface BridgeRoots {
  codexSessionsDir: string;
  claudeProjectsDir: string;
  stateRoots: string[];
}

export interface BridgeContext {
  roots: BridgeRoots;
  /** Environment for the spawned `codex app-server` (PATH, CODEX_HOME, ...). */
  env: NodeJS.ProcessEnv;
  /** Working directory for the spawned `codex app-server`. */
  cwd: string;
  searchTimeMs: number;
  appServerTimeoutMs: number;
}

/** Bad input from the caller: reported as a tool error, never a crash. */
export class BridgeInputError extends Error {}

// --- context ---------------------------------------------------------------

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function resolveBridgeContext(env: NodeJS.ProcessEnv = process.env): BridgeContext {
  const home = env.HOME || os.homedir();
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const claudeDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"));

  let stateRoots: string[];
  if (env.CODEX_CHAT_BRIDGE_STATE_ROOTS) {
    stateRoots = env.CODEX_CHAT_BRIDGE_STATE_ROOTS.split(path.delimiter).filter(Boolean);
  } else {
    stateRoots = [
      ...(env.CLAUDE_PLUGIN_DATA ? [path.join(env.CLAUDE_PLUGIN_DATA, "state")] : []),
      ...PLUGIN_DATA_DIR_NAMES.map((name) => path.join(claudeDir, "plugins", "data", name, "state")),
      path.join(realpathOrSelf(env.TMPDIR || os.tmpdir()), "codex-companion")
    ];
  }

  const searchTimeMs = Number(env.CODEX_CHAT_BRIDGE_SEARCH_MS);
  return {
    roots: {
      codexSessionsDir: path.join(codexHome, "sessions"),
      claudeProjectsDir: path.join(claudeDir, "projects"),
      stateRoots: [...new Set(stateRoots.map((root) => path.resolve(root)))]
    },
    env,
    cwd: process.cwd(),
    searchTimeMs: Number.isFinite(searchTimeMs) && searchTimeMs > 0 ? searchTimeMs : DEFAULT_SEARCH_TIME_MS,
    appServerTimeoutMs: DEFAULT_APP_SERVER_TIMEOUT_MS
  };
}

// --- small helpers -----------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonLine(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new BridgeInputError(`Expected a number, got ${JSON.stringify(value)}.`);
  }
  return Math.max(min, Math.min(Math.trunc(number), max));
}

export function clampBudget(value: unknown): number {
  return clampInt(value, DEFAULT_BUDGET_CHARS, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS);
}

function oneLine(text: unknown, limit: number): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, limit - 3))}...`;
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(1, limit - 3))}...`;
}

function tailPath(value: string | null | undefined, limit = 70): string {
  if (!value) {
    return "?";
  }
  return value.length <= limit ? value : `...${value.slice(value.length - (limit - 3))}`;
}

function formatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) {
    return "?";
  }
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function epochToMs(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return number > 1e12 ? number : number * 1000;
}

function formatElapsed(fromIso: unknown, nowMs = Date.now()): string {
  const start = Date.parse(String(fromIso ?? ""));
  if (!Number.isFinite(start) || nowMs < start) {
    return "?";
  }
  const total = Math.round((nowMs - start) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// --- redaction ---------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [
    /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["']?)([^\s"',;&]{8,})/gi,
    "$1[REDACTED]"
  ]
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// --- bounded output ------------------------------------------------------------

class BoundedOutput {
  budget: number;
  lines: string[] = [];
  used = 0;
  truncated = false;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Adds a line if it fits; a first line that alone overflows is clipped. */
  add(line: string): boolean {
    const available = this.budget - NOTICE_RESERVE_CHARS - this.used;
    const cost = line.length + 1;
    if (cost <= available) {
      this.lines.push(line);
      this.used += cost;
      return true;
    }
    this.truncated = true;
    if (this.lines.length === 0 && available > 40) {
      this.lines.push(`${line.slice(0, available - 20)} ...[clipped]`);
      this.used = this.budget - NOTICE_RESERVE_CHARS;
      return true;
    }
    return false;
  }

  render(header: string[] = [], footer: string[] = []): string {
    return redactSecrets([...header, ...this.lines, ...footer].join("\n"));
  }
}

// --- path and id safety ------------------------------------------------------------

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve `candidate` and require it to stay inside `root`, both lexically and
 * after following symlinks. Auth and config files are refused outright.
 */
export function assertUnderRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (!isWithin(resolvedRoot, resolved)) {
    throw new BridgeInputError("Path escapes the allowed root.");
  }
  if (FORBIDDEN_BASENAMES.has(path.basename(resolved).toLowerCase())) {
    throw new BridgeInputError("Refusing to read credential or config files.");
  }
  if (fs.existsSync(resolved)) {
    const realRoot = realpathOrSelf(resolvedRoot);
    const realTarget = realpathOrSelf(resolved);
    if (!isWithin(realRoot, realTarget)) {
      throw new BridgeInputError("Path escapes the allowed root via a symlink.");
    }
  }
  return resolved;
}

export function validateCodexId(id: unknown): string {
  const value = asString(id)?.trim() ?? "";
  if (!CODEX_ID_PATTERN.test(value)) {
    throw new BridgeInputError("Invalid Codex thread id: use an id from list_chats (letters, digits, '-', '_').");
  }
  return value;
}

/**
 * Claude chat ids: `<sessionId>` for a session transcript, or
 * `<sessionId>/<path under subagents/ without .jsonl>` for a subagent
 * transcript (e.g. `abc/agent-123` or `abc/workflows/wf_1/agent-123`).
 */
export function validateClaudeId(id: unknown): { sessionId: string; subPath: string[] } {
  const value = asString(id)?.trim() ?? "";
  const segments = value.split("/");
  if (!value || segments.length > 6 || segments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment) || segment.includes(".."))) {
    throw new BridgeInputError("Invalid Claude chat id: use an id from list_chats or search_chats.");
  }
  if (segments.length > 1 && !/^agent-/.test(segments[segments.length - 1])) {
    throw new BridgeInputError("Invalid Claude subagent id: the last segment must be an agent-* transcript.");
  }
  return { sessionId: segments[0], subPath: segments.slice(1) };
}

function requireAbsoluteCwd(cwd: unknown): string | null {
  if (cwd === undefined || cwd === null || cwd === "") {
    return null;
  }
  const value = asString(cwd);
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new BridgeInputError("cwd must be an absolute path.");
  }
  return path.resolve(value);
}

function parseSource(value: unknown, allowAll: boolean): ChatSourceFilter {
  if (value === undefined || value === null || value === "") {
    if (allowAll) {
      return "all";
    }
    throw new BridgeInputError('source is required: "codex" or "claude".');
  }
  if (value === "codex" || value === "claude" || (allowAll && value === "all")) {
    return value;
  }
  throw new BridgeInputError(`Invalid source ${JSON.stringify(value)}: expected ${allowAll ? '"codex", "claude", or "all"' : '"codex" or "claude"'}.`);
}

// --- cursors -------------------------------------------------------------------

function encodeCursor(value: JsonObject): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): JsonObject | null {
  if (cursor === undefined || cursor === null || cursor === "") {
    return null;
  }
  const value = asString(cursor);
  if (!value || value.length > 4096) {
    throw new BridgeInputError("Invalid cursor.");
  }
  const parsed = asObject((() => {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  })());
  if (!parsed) {
    throw new BridgeInputError("Invalid cursor: pass the cursor string exactly as a previous call returned it.");
  }
  return parsed;
}

function cursorNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

// --- file reading ------------------------------------------------------------------

function readHeadTailLines(file: string): { head: string[]; tail: string[] } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const headLength = Math.min(size, HEAD_BYTES);
    const headBuffer = Buffer.alloc(headLength);
    fs.readSync(fd, headBuffer, 0, headLength, 0);
    const headLines = headBuffer.toString("utf8").split("\n");
    if (size > headLength) {
      headLines.pop();
    }
    let tailLines: string[] = [];
    if (size > headLength) {
      const tailStart = Math.max(headLength, size - TAIL_BYTES);
      const tailBuffer = Buffer.alloc(size - tailStart);
      fs.readSync(fd, tailBuffer, 0, tailBuffer.length, tailStart);
      tailLines = tailBuffer.toString("utf8").split("\n");
      if (tailStart > headLength) {
        tailLines.shift();
      }
    }
    return { head: headLines.filter((line) => line.trim()), tail: tailLines.filter((line) => line.trim()) };
  } catch {
    return { head: [], tail: [] };
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

async function* streamLines(file: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// --- Codex rollout files ---------------------------------------------------------------

interface CodexRolloutFile {
  file: string;
  mtimeMs: number;
}

/** Rollout files under sessions/YYYY/MM/DD, newest date directories first. */
function listCodexRolloutFiles(ctx: BridgeContext): CodexRolloutFile[] {
  const root = ctx.roots.codexSessionsDir;
  const files: CodexRolloutFile[] = [];
  const numericDirs = (dir: string) =>
    safeReaddir(dir)
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  for (const year of numericDirs(root)) {
    for (const month of numericDirs(path.join(root, year))) {
      for (const day of numericDirs(path.join(root, year, month))) {
        const dayDir = path.join(root, year, month, day);
        for (const entry of safeReaddir(dayDir)) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
            continue;
          }
          const file = path.join(dayDir, entry.name);
          files.push({ file, mtimeMs: safeStat(file)?.mtimeMs ?? 0 });
        }
      }
    }
  }
  return files;
}

function findCodexRolloutFile(ctx: BridgeContext, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`;
  const match = listCodexRolloutFiles(ctx).find((entry) => path.basename(entry.file).endsWith(suffix));
  return match ? assertUnderRoot(ctx.roots.codexSessionsDir, match.file) : null;
}

const INJECTED_TEXT_PATTERN =
  /^\s*(?:<(?:environment_context|user_instructions|recommended_plugins|app-context|skills_instructions|permissions instructions|collaboration_mode|multi_agent_role|image |system-reminder|local-command|command-)|# AGENTS\.md instructions|<\/image>|Caveat: )/i;

interface TextPart {
  kind: "user" | "assistant" | "tool";
  text: string;
}

function contentTexts(content: unknown, acceptedTypes: string[]): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of content) {
    const object = asObject(part);
    if (object && acceptedTypes.includes(String(object.type)) && typeof object.text === "string") {
      texts.push(object.text);
    }
  }
  return texts;
}

function userTexts(content: unknown, acceptedTypes: string[]): string[] {
  return contentTexts(content, acceptedTypes).filter((text) => text.trim() && !INJECTED_TEXT_PATTERN.test(text));
}

/** Searchable / readable text of one rollout line (messages and tool calls). */
function codexLineParts(record: JsonObject): TextPart[] {
  if (record.type !== "response_item") {
    return [];
  }
  const payload = asObject(record.payload);
  if (!payload) {
    return [];
  }
  switch (payload.type) {
    case "message": {
      if (payload.role === "user") {
        return userTexts(payload.content, ["input_text", "text"]).map((text) => ({ kind: "user", text }));
      }
      if (payload.role === "assistant") {
        return contentTexts(payload.content, ["output_text", "text"]).map((text) => ({ kind: "assistant", text }));
      }
      return [];
    }
    case "function_call":
      return [{ kind: "tool", text: `${payload.name ?? "?"} ${payload.arguments ?? ""}` }];
    case "custom_tool_call":
      return [{ kind: "tool", text: `${payload.name ?? "?"} ${payload.input ?? ""}` }];
    case "local_shell_call": {
      const action = asObject(payload.action);
      const command = Array.isArray(action?.command) ? action.command.join(" ") : "";
      return [{ kind: "tool", text: `shell ${command}` }];
    }
    case "web_search_call": {
      const action = asObject(payload.action);
      return [{ kind: "tool", text: `web_search ${action?.query ?? ""}` }];
    }
    default:
      return [];
  }
}

interface CodexSessionMeta {
  id: string | null;
  cwd: string | null;
  isSubagent: boolean;
  parentId: string | null;
}

function codexSessionMeta(record: JsonObject | null): CodexSessionMeta | null {
  if (!record || record.type !== "session_meta") {
    return null;
  }
  const payload = asObject(record.payload) ?? {};
  const source = payload.source;
  const subagent = asObject(asObject(source)?.subagent);
  const spawn = asObject(subagent?.thread_spawn);
  return {
    id: asString(payload.id),
    cwd: asString(payload.cwd),
    isSubagent: Boolean(subagent) || payload.thread_source === "subagent",
    parentId: asString(spawn?.parent_thread_id) ?? asString(payload.forked_from_id)
  };
}

// --- Claude transcripts --------------------------------------------------------------

interface ClaudeEntry {
  id: string;
  file: string;
  mtimeMs: number;
  projectDir: string;
  parentId: string | null;
}

export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function listClaudeProjectDirs(ctx: BridgeContext, cwd: string | null): string[] {
  const root = ctx.roots.claudeProjectsDir;
  if (cwd) {
    const encoded = path.join(root, encodeClaudeProjectDir(cwd));
    if (safeStat(encoded)?.isDirectory()) {
      return [encoded];
    }
  }
  return safeReaddir(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function collectSubagentFiles(dir: string, relative: string[], depth: number, out: Array<{ file: string; rel: string[] }>) {
  if (depth > 4) {
    return;
  }
  for (const entry of safeReaddir(dir)) {
    if (!PATH_SEGMENT_PATTERN.test(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSubagentFiles(full, [...relative, entry.name], depth + 1, out);
    } else if (entry.isFile() && /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) {
      out.push({ file: full, rel: [...relative, entry.name.slice(0, -".jsonl".length)] });
    }
  }
}

function listClaudeEntries(ctx: BridgeContext, options: { cwd: string | null; includeSubagents: boolean }): ClaudeEntry[] {
  const entries: ClaudeEntry[] = [];
  for (const projectDir of listClaudeProjectDirs(ctx, options.cwd)) {
    for (const entry of safeReaddir(projectDir)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const sessionId = entry.name.slice(0, -".jsonl".length);
        if (!PATH_SEGMENT_PATTERN.test(sessionId)) {
          continue;
        }
        const file = path.join(projectDir, entry.name);
        entries.push({ id: sessionId, file, mtimeMs: safeStat(file)?.mtimeMs ?? 0, projectDir, parentId: null });
      } else if (options.includeSubagents && entry.isDirectory() && PATH_SEGMENT_PATTERN.test(entry.name)) {
        const found: Array<{ file: string; rel: string[] }> = [];
        collectSubagentFiles(path.join(projectDir, entry.name, "subagents"), [], 0, found);
        for (const { file, rel } of found) {
          entries.push({
            id: [entry.name, ...rel].join("/"),
            file,
            mtimeMs: safeStat(file)?.mtimeMs ?? 0,
            projectDir,
            parentId: entry.name
          });
        }
      }
    }
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function resolveClaudeFile(ctx: BridgeContext, id: unknown): { id: string; file: string } {
  const { sessionId, subPath } = validateClaudeId(id);
  const root = ctx.roots.claudeProjectsDir;
  for (const projectDir of listClaudeProjectDirs(ctx, null)) {
    const relative =
      subPath.length === 0
        ? path.join(path.basename(projectDir), `${sessionId}.jsonl`)
        : path.join(path.basename(projectDir), sessionId, "subagents", ...subPath.slice(0, -1), `${subPath[subPath.length - 1]}.jsonl`);
    const candidate = assertUnderRoot(root, relative);
    if (safeStat(candidate)?.isFile()) {
      return { id: [sessionId, ...subPath].join("/"), file: candidate };
    }
  }
  throw new BridgeInputError(`No Claude chat found for id ${[sessionId, ...subPath].join("/")}.`);
}

interface ClaudeMeta {
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  model: string | null;
}

function claudeUserPromptText(record: JsonObject): string | null {
  if (record.type !== "user" || record.isMeta === true) {
    return null;
  }
  const message = asObject(record.message);
  const text = userTexts(message?.content, ["text"]).join("\n");
  return text.trim() ? text : null;
}

function readClaudeMeta(entry: ClaudeEntry): ClaudeMeta {
  const { head, tail } = readHeadTailLines(entry.file);
  const meta: ClaudeMeta = { title: null, firstPrompt: null, lastPrompt: null, cwd: null, model: null };
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  for (const line of [...head, ...tail]) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }
    if (!meta.cwd && typeof record.cwd === "string") {
      meta.cwd = record.cwd;
    }
    if (record.type === "custom-title" && typeof record.customTitle === "string") {
      customTitle = record.customTitle;
    } else if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      aiTitle = record.aiTitle;
    } else if (record.type === "agent-name" && typeof record.agentName === "string") {
      agentName = record.agentName;
    } else if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
      meta.lastPrompt = record.lastPrompt;
    } else if (!meta.firstPrompt) {
      meta.firstPrompt = claudeUserPromptText(record);
    }
    if (record.type === "assistant") {
      const model = asString(asObject(record.message)?.model);
      if (model && !model.startsWith("<")) {
        meta.model = model;
      }
    }
  }

  if (entry.parentId) {
    // Subagent transcripts carry their task description in a sibling meta file.
    try {
      const sidecar = asObject(JSON.parse(fs.readFileSync(entry.file.replace(/\.jsonl$/, ".meta.json"), "utf8")));
      const description = asString(sidecar?.description);
      const agentType = asString(sidecar?.agentType);
      if (description) {
        customTitle = agentType ? `[${agentType}] ${description}` : description;
      }
    } catch {
      // No sidecar: fall back to the first prompt.
    }
  } else if (!customTitle) {
    try {
      const sidecar = asObject(
        JSON.parse(fs.readFileSync(path.join(entry.projectDir, entry.id, "custom-title.json"), "utf8"))
      );
      customTitle = asString(sidecar?.customTitle);
    } catch {
      // Not renamed.
    }
  }
  meta.title = customTitle ?? aiTitle ?? agentName;
  return meta;
}

// --- Codex app-server --------------------------------------------------------------

interface CodexThreadInfo {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  updatedAt?: number | null;
  createdAt?: number | null;
  model?: string | null;
  reasoningEffort?: string | null;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  status?: { type?: string } | null;
}

interface CodexReadClient {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

async function withCodexClient<T>(ctx: BridgeContext, fn: (client: CodexReadClient) => Promise<T>): Promise<T> {
  // Direct and ephemeral on purpose: a read must never create or reuse the
  // persistent broker, and the turn-complete notify hook is irrelevant here.
  const client = await withTimeout(
    CodexAppServerClient.connect(ctx.cwd, {
      disableBroker: true,
      disableTurnCompleteHook: true,
      env: ctx.env,
      clientInfo: { name: "codex-chat-bridge", title: "Codex Chat Bridge", version: "1" }
    }),
    ctx.appServerTimeoutMs,
    "Timed out starting codex app-server."
  );
  // The typed client narrows method params to the generated schema, which can
  // lag the CLI (e.g. thread/items/list entries); this bridge validates the
  // response shapes itself, so it talks to it through a loose view.
  const loose = client as unknown as CodexReadClient;
  try {
    return await fn({
      request: (method, params) => withTimeout(loose.request(method, params), ctx.appServerTimeoutMs, `Timed out waiting for ${method}.`),
      close: () => loose.close()
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function fetchCodexThreads(
  ctx: BridgeContext,
  options: { cursor: string | null; limit: number; search: string | null; cwd: string | null; includeSubagents: boolean }
): Promise<{ threads: CodexThreadInfo[]; nextCursor: string | null }> {
  return withCodexClient(ctx, async (client) => {
    const response = asObject(
      await client.request("thread/list", {
        cursor: options.cursor,
        limit: options.limit,
        sortKey: "updated_at",
        sourceKinds: options.includeSubagents ? [...INTERACTIVE_SOURCE_KINDS, ...SUBAGENT_SOURCE_KINDS] : INTERACTIVE_SOURCE_KINDS,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.search ? { searchTerm: options.search } : {})
      })
    );
    const data = Array.isArray(response?.data) ? response.data : [];
    const threads = data
      .map((thread) => asObject(thread))
      .filter((thread): thread is JsonObject => Boolean(thread && typeof thread.id === "string"))
      .map((thread) => thread as unknown as CodexThreadInfo)
      .filter((thread) => options.includeSubagents || !thread.parentThreadId);
    return { threads: threads.slice(0, options.limit), nextCursor: asString(response?.nextCursor) };
  });
}

// --- list_chats ---------------------------------------------------------------------

interface ChatRow {
  source: ChatSource;
  id: string;
  updatedMs: number;
  line: string;
}

function codexRow(thread: CodexThreadInfo): ChatRow {
  const updatedMs = epochToMs(thread.updatedAt) ?? epochToMs(thread.createdAt) ?? 0;
  const title = thread.name || thread.preview || "(no preview)";
  const parts = [
    "codex",
    thread.id,
    formatTime(updatedMs),
    tailPath(thread.cwd),
    [thread.model ?? "model?", thread.reasoningEffort].filter(Boolean).join("/")
  ];
  if (thread.parentThreadId) {
    parts.push(`parent=${thread.parentThreadId}${thread.agentNickname ? ` (${thread.agentNickname})` : ""}`);
  }
  if (thread.status?.type === "active") {
    parts.push("ACTIVE");
  }
  parts.push(oneLine(title, 100));
  return { source: "codex", id: thread.id, updatedMs, line: parts.join(" | ") };
}

function claudeRow(entry: ClaudeEntry, meta: ClaudeMeta): ChatRow {
  const title = meta.title || meta.firstPrompt || meta.lastPrompt || "(no prompt)";
  const parts = ["claude", entry.id, formatTime(entry.mtimeMs), tailPath(meta.cwd)];
  if (meta.model) {
    parts.push(meta.model);
  }
  if (entry.parentId) {
    parts.push(`parent=${entry.parentId}`);
  }
  parts.push(oneLine(title, 100));
  return { source: "claude", id: entry.id, updatedMs: entry.mtimeMs, line: parts.join(" | ") };
}

function claudeMatches(meta: ClaudeMeta, search: string | null): boolean {
  if (!search) {
    return true;
  }
  const needle = search.toLowerCase();
  return [meta.title, meta.firstPrompt, meta.lastPrompt].some((value) => value?.toLowerCase().includes(needle));
}

function claudePage(
  ctx: BridgeContext,
  options: { offset: number; limit: number; search: string | null; cwd: string | null; includeSubagents: boolean }
): { rows: ChatRow[]; hasMore: boolean } {
  const rows: ChatRow[] = [];
  let matched = 0;
  for (const entry of listClaudeEntries(ctx, options)) {
    const needsMeta = options.search || options.cwd || matched >= options.offset;
    if (!needsMeta) {
      matched += 1;
      continue;
    }
    const meta = readClaudeMeta(entry);
    if (options.cwd && meta.cwd && path.resolve(meta.cwd) !== options.cwd) {
      continue;
    }
    if (!claudeMatches(meta, options.search)) {
      continue;
    }
    matched += 1;
    if (matched <= options.offset) {
      continue;
    }
    if (rows.length === options.limit) {
      return { rows, hasMore: true };
    }
    rows.push(claudeRow(entry, meta));
  }
  return { rows, hasMore: false };
}

export interface ListChatsArgs {
  source?: unknown;
  search?: unknown;
  cwd?: unknown;
  includeSubagents?: unknown;
  limit?: unknown;
  cursor?: unknown;
  budgetChars?: unknown;
}

export async function listChats(ctx: BridgeContext, args: ListChatsArgs = {}): Promise<string> {
  const source = parseSource(args.source, true);
  const limit = clampInt(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const budget = clampBudget(args.budgetChars);
  const search = asString(args.search)?.trim() || null;
  const cwd = requireAbsoluteCwd(args.cwd);
  const includeSubagents = args.includeSubagents === true;
  const state = decodeCursor(args.cursor) ?? {};

  const codexCursor = asString(state.cc);
  const codexSkip = cursorNumber(state.cs);
  const codexDone = source === "claude" || state.cd === true;
  const claudeOffset = cursorNumber(state.lo);
  const claudeDone = source === "codex" || state.ld === true;
  const notes: string[] = [];

  let codexRows: ChatRow[] = [];
  let codexNext: string | null = null;
  let codexFailed = false;
  if (!codexDone) {
    try {
      const page = await fetchCodexThreads(ctx, { cursor: codexCursor, limit: Math.min(codexSkip + limit, 500), search, cwd, includeSubagents });
      codexRows = page.threads.slice(codexSkip).map(codexRow);
      codexNext = page.nextCursor;
    } catch (error) {
      if (source === "codex") {
        throw error;
      }
      codexFailed = true;
      notes.push(`Codex listing unavailable: ${oneLine(error instanceof Error ? error.message : error, 200)}`);
    }
  }

  let claudeRows: ChatRow[] = [];
  let claudeHasMore = false;
  if (!claudeDone) {
    const page = claudePage(ctx, { offset: claudeOffset, limit, search, cwd, includeSubagents });
    claudeRows = page.rows;
    claudeHasMore = page.hasMore;
  }

  const merged = [...codexRows, ...claudeRows].sort((left, right) => right.updatedMs - left.updatedMs).slice(0, limit);
  const output = new BoundedOutput(budget);
  let codexShown = 0;
  let claudeShown = 0;
  for (const row of merged) {
    if (!output.add(row.line)) {
      break;
    }
    if (row.source === "codex") {
      codexShown += 1;
    } else {
      claudeShown += 1;
    }
  }

  const next: JsonObject = {};
  if (codexDone || codexFailed) {
    next.cd = true;
  } else if (codexShown === codexRows.length) {
    if (codexNext) {
      next.cc = codexNext;
    } else {
      next.cd = true;
    }
  } else {
    next.cc = codexCursor;
    next.cs = codexSkip + codexShown;
  }
  if (claudeDone || (!claudeHasMore && claudeShown === claudeRows.length)) {
    next.ld = true;
  } else {
    next.lo = claudeOffset + claudeShown;
  }
  const nextCursor = next.cd === true && next.ld === true ? null : encodeCursor(next);

  const header = [`Chats (${source}${search ? `, search "${oneLine(search, 60)}"` : ""}${cwd ? `, cwd ${tailPath(cwd)}` : ""}), newest first: source | id | updated | cwd | model | title`];
  const footer = [...notes];
  if (merged.length === 0) {
    footer.push("No chats matched.");
  }
  if (output.truncated) {
    footer.push(`Output truncated at ${budget} chars; raise budgetChars (max ${MAX_BUDGET_CHARS}) or lower limit.`);
  }
  if (nextCursor) {
    footer.push(`More chats: call again with cursor "${nextCursor}".`);
  }
  if (source !== "claude" && search) {
    footer.push("(Codex search matches thread titles and user prompts only; use search_chats for full text.)");
  }
  return output.render(header, footer);
}

// --- search_chats ------------------------------------------------------------------

export interface SearchChatsArgs {
  query?: unknown;
  source?: unknown;
  cwd?: unknown;
  includeSubagents?: unknown;
  includeTools?: unknown;
  limit?: unknown;
  budgetChars?: unknown;
}

interface SearchCandidate {
  source: ChatSource;
  file: string;
  mtimeMs: number;
  id: string | null;
  isSubagent: boolean;
}

function buildSnippet(text: string, index: number, length: number): string {
  const half = Math.floor((SNIPPET_CHARS - length) / 2);
  const start = Math.max(0, index - Math.max(half, 20));
  const end = Math.min(text.length, index + length + Math.max(half, 20));
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${body}${end < text.length ? "..." : ""}`;
}

function claudeLineParts(record: JsonObject): TextPart[] {
  const message = asObject(record.message);
  if (record.type === "user") {
    if (record.isMeta === true) {
      return [];
    }
    const parts: TextPart[] = userTexts(message?.content, ["text"]).map((text) => ({ kind: "user", text }));
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        const object = asObject(part);
        if (object?.type === "tool_result") {
          const text = contentTexts(object.content, ["text"]).join("\n");
          parts.push({ kind: "tool", text: `result${object.is_error ? " (error)" : ""}: ${text}` });
        }
      }
    }
    return parts;
  }
  if (record.type === "assistant" && Array.isArray(message?.content)) {
    const parts: TextPart[] = [];
    for (const part of message.content) {
      const object = asObject(part);
      if (object?.type === "text" && typeof object.text === "string") {
        parts.push({ kind: "assistant", text: object.text });
      } else if (object?.type === "tool_use") {
        parts.push({ kind: "tool", text: `${object.name ?? "?"} ${summarizeToolInput(object.input)}` });
      }
    }
    return parts;
  }
  return [];
}

function summarizeToolInput(input: unknown): string {
  const object = asObject(input);
  if (!object) {
    return "";
  }
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return JSON.stringify(object);
}

function lineMayMatch(source: ChatSource, line: string): boolean {
  if (source === "codex") {
    return line.includes('"response_item"');
  }
  return line.includes('"type":"user"') || line.includes('"type":"assistant"');
}

export async function searchChats(ctx: BridgeContext, args: SearchChatsArgs = {}): Promise<string> {
  const query = asString(args.query)?.trim() ?? "";
  if (!query) {
    throw new BridgeInputError("query is required.");
  }
  if (query.length > 500) {
    throw new BridgeInputError("query is too long (max 500 chars).");
  }
  const source = parseSource(args.source, true);
  const cwd = requireAbsoluteCwd(args.cwd);
  const includeSubagents = args.includeSubagents === true;
  const includeTools = args.includeTools === true;
  const limit = clampInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const budget = clampBudget(args.budgetChars);
  const needle = query.toLowerCase();
  // A raw-line regex prefilter is exact unless the query contains characters
  // JSON escapes (quotes, backslashes, control characters).
  const rawPrefilter = /["\\\u0000-\u001f]/.test(query) ? null : new RegExp(escapeRegExp(query), "i");

  const candidates: SearchCandidate[] = [];
  if (source !== "claude") {
    for (const entry of listCodexRolloutFiles(ctx)) {
      candidates.push({ source: "codex", file: entry.file, mtimeMs: entry.mtimeMs, id: null, isSubagent: false });
    }
  }
  if (source !== "codex") {
    for (const entry of listClaudeEntries(ctx, { cwd, includeSubagents })) {
      candidates.push({ source: "claude", file: entry.file, mtimeMs: entry.mtimeMs, id: entry.id, isSubagent: Boolean(entry.parentId) });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const deadline = Date.now() + ctx.searchTimeMs;
  const rows: string[] = [];
  let scanned = 0;
  let timedOut = false;

  for (const candidate of candidates) {
    if (rows.length >= limit) {
      break;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const root = candidate.source === "codex" ? ctx.roots.codexSessionsDir : ctx.roots.claudeProjectsDir;
    const file = assertUnderRoot(root, candidate.file);
    scanned += 1;
    let chatId = candidate.id;
    let matchesInChat = 0;
    let firstLine = true;
    let claudeCwdChecked = !cwd || candidate.source !== "claude";

    for await (const line of streamLines(file)) {
      if (firstLine && candidate.source === "codex") {
        firstLine = false;
        const meta = codexSessionMeta(parseJsonLine(line));
        if (!meta?.id || (cwd && meta.cwd && path.resolve(meta.cwd) !== cwd) || (meta.isSubagent && !includeSubagents)) {
          break;
        }
        chatId = meta.id;
        continue;
      }
      if (!claudeCwdChecked && line.includes('"cwd"')) {
        const record = parseJsonLine(line);
        if (typeof record?.cwd === "string") {
          claudeCwdChecked = true;
          if (path.resolve(record.cwd) !== cwd) {
            break;
          }
        }
      }
      if (!lineMayMatch(candidate.source, line) || (rawPrefilter && !rawPrefilter.test(line))) {
        continue;
      }
      const record = parseJsonLine(line);
      if (!record) {
        continue;
      }
      const parts = candidate.source === "codex" ? codexLineParts(record) : claudeLineParts(record);
      for (const part of parts) {
        if (part.kind === "tool" && !includeTools) {
          continue;
        }
        const index = part.text.toLowerCase().indexOf(needle);
        if (index === -1) {
          continue;
        }
        const time = formatTime(epochToMs(record.timestamp));
        rows.push(`${candidate.source} | ${chatId ?? "?"} | ${time} | ${part.kind} | ${buildSnippet(part.text, index, query.length)}`);
        matchesInChat += 1;
        break;
      }
      if (rows.length >= limit || matchesInChat >= MAX_MATCHES_PER_CHAT) {
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
    }
    if (timedOut) {
      break;
    }
  }

  const output = new BoundedOutput(budget);
  for (const row of rows) {
    if (!output.add(row)) {
      break;
    }
  }
  const header = [`Search "${oneLine(query, 60)}" (${source}${cwd ? `, cwd ${tailPath(cwd)}` : ""}): source | chat id | time | kind | snippet`];
  const footer = [`Scanned ${scanned} of ${candidates.length} chat files, newest first; up to ${MAX_MATCHES_PER_CHAT} matches per chat.`];
  if (rows.length === 0) {
    footer.push("No matches.");
  }
  if (rows.length >= limit) {
    footer.push(`Stopped at limit ${limit}; older chats were not scanned. Narrow with cwd/source or raise limit.`);
  }
  if (timedOut) {
    footer.push(`Stopped at the ${Math.round(ctx.searchTimeMs / 1000)}s time budget; narrow with cwd or source.`);
  }
  if (output.truncated) {
    footer.push(`Output truncated at ${budget} chars; raise budgetChars (max ${MAX_BUDGET_CHARS}) or lower limit.`);
  }
  return output.render(header, footer);
}

// --- read_chat ------------------------------------------------------------------------

export interface ReadChatArgs {
  id?: unknown;
  source?: unknown;
  turnId?: unknown;
  limit?: unknown;
  cursor?: unknown;
  budgetChars?: unknown;
}

interface ReadItem {
  prefix: string;
  kind: string;
  text: string;
}

function renderReadItem(item: ReadItem, textLimit: number): string {
  const text = textLimit > MULTI_ITEM_TEXT_CHARS ? clip(item.text, textLimit) : oneLine(item.text, textLimit);
  return `${item.prefix ? `${item.prefix} ` : ""}${item.kind}: ${text}`;
}

/**
 * Fill the budget from the newest item backwards, then print oldest-first so
 * the newest item is last. Returns how many of `newestFirst` were shown.
 */
function renderNewestLast(newestFirst: ReadItem[], budget: number, textLimit: number): { output: BoundedOutput; shown: number } {
  const output = new BoundedOutput(budget);
  let shown = 0;
  for (const item of newestFirst) {
    if (!output.add(renderReadItem(item, textLimit))) {
      break;
    }
    shown += 1;
  }
  output.lines.reverse();
  return { output, shown };
}

function codexApiItem(entry: unknown): { turnId: string | null; item: JsonObject } | null {
  const object = asObject(entry);
  if (!object) {
    return null;
  }
  const nested = asObject(object.item);
  if (nested) {
    return { turnId: asString(object.turnId), item: nested };
  }
  return typeof object.type === "string" ? { turnId: asString(object.turnId), item: object } : null;
}

function codexItemToReadItem(turnId: string | null, raw: JsonObject, textLimit: number): ReadItem | null {
  const compact = compactItem(raw, textLimit) as JsonObject;
  const prefix = turnId ? `[${turnId.slice(0, 8)}]` : "";
  const status = compact.status ? ` [${compact.status}${compact.exitCode != null ? ` exit ${compact.exitCode}` : ""}]` : "";
  switch (raw.type) {
    case "userMessage":
      return { prefix, kind: "user", text: String(compact.text ?? "") };
    case "agentMessage":
      return { prefix, kind: "assistant", text: String(compact.text ?? "") };
    case "reasoning":
      return compact.summary ? { prefix, kind: "reasoning", text: String(compact.summary) } : null;
    case "commandExecution":
      return { prefix, kind: `tool shell${status}`, text: String(compact.command ?? "") };
    case "fileChange":
      return { prefix, kind: `tool edit${status}`, text: Array.isArray(compact.paths) ? compact.paths.join(", ") : "" };
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return { prefix, kind: `tool ${compact.tool ?? raw.type}${status}`, text: "" };
    case "webSearch":
      return { prefix, kind: "tool web_search", text: String(compact.query ?? "") };
    default: {
      const detail = [raw.text, raw.revisedPrompt, raw.savedPath, raw.review].find((value) => typeof value === "string" && value.trim());
      return { prefix, kind: String(raw.type ?? "item"), text: typeof detail === "string" ? detail : "" };
    }
  }
}

interface CodexReadPage {
  newestFirst: ReadItem[];
  /** Items mode: raw entry index (within the fetched page) of each item. */
  rawIndexes: number[];
  rawCount: number;
  apiCursor: string | null;
  skip: number;
  apiNext: string | null;
  mode: "items" | "turns";
}

async function readCodexViaAppServer(
  ctx: BridgeContext,
  options: { id: string; turnId: string | null; limit: number; state: JsonObject; textLimit: number }
): Promise<CodexReadPage> {
  return withCodexClient(ctx, async (client) => {
    const apiCursor = options.state.m === "turns" ? null : asString(options.state.a);
    const skip = cursorNumber(options.state.s);
    if (options.state.m !== "turns") {
      try {
        const response = asObject(
          await client.request("thread/items/list", {
            threadId: options.id,
            ...(options.turnId ? { turnId: options.turnId } : {}),
            cursor: apiCursor,
            // Over-fetch: some entries (e.g. reasoning without a summary)
            // render as nothing, and the page should still fill `limit`.
            limit: Math.min(skip + options.limit * 3, 300),
            sortDirection: "desc"
          })
        );
        const entries = (Array.isArray(response?.data) ? response.data : []).map(codexApiItem);
        const newestFirst: ReadItem[] = [];
        const rawIndexes: number[] = [];
        for (let index = skip; index < entries.length && newestFirst.length < options.limit; index += 1) {
          const entry = entries[index];
          const item = entry ? codexItemToReadItem(entry.turnId, entry.item, options.textLimit) : null;
          if (item) {
            newestFirst.push(item);
            rawIndexes.push(index);
          }
        }
        return {
          newestFirst,
          rawIndexes,
          rawCount: entries.length,
          apiCursor,
          skip,
          apiNext: asString(response?.nextCursor),
          mode: "items" as const
        };
      } catch (error) {
        if (!isMethodUnavailableError(error)) {
          throw error;
        }
      }
    }

    // Fallback for CLIs without thread/items/list: walk turns newest-first
    // and page by item offset (the fallback cursor is offset-only).
    const collected: ReadItem[] = [];
    let turnsCursor: string | null = null;
    let hasMoreTurns = false;
    for (let page = 0; page < MAX_TURN_PAGES && collected.length < skip + options.limit; page += 1) {
      const response = asObject(
        await client.request("thread/turns/list", { threadId: options.id, cursor: turnsCursor, limit: 10, sortDirection: "desc", itemsView: "full" })
      );
      const turns = Array.isArray(response?.data) ? response.data : [];
      for (const turnValue of turns) {
        const turn = asObject(turnValue);
        const turnId = asString(turn?.id);
        if (!turn || (options.turnId && turnId !== options.turnId && !turnId?.startsWith(options.turnId))) {
          continue;
        }
        const items = (Array.isArray(turn.items) ? turn.items : []).map(asObject).filter(Boolean).reverse();
        for (const raw of items) {
          const item = codexItemToReadItem(turnId, raw, options.textLimit);
          if (item) {
            collected.push(item);
          }
        }
      }
      turnsCursor = asString(response?.nextCursor);
      hasMoreTurns = Boolean(turnsCursor);
      if (!turnsCursor) {
        break;
      }
    }
    const newestFirst = collected.slice(skip, skip + options.limit);
    const moreItems = collected.length > skip + options.limit || hasMoreTurns;
    return { newestFirst, rawIndexes: [], rawCount: 0, apiCursor: null, skip, apiNext: moreItems ? "offset" : null, mode: "turns" as const };
  });
}

function readCodexRolloutItems(file: string, textLimit: number): Promise<ReadItem[]> {
  return (async () => {
    const items: ReadItem[] = [];
    for await (const line of streamLines(file)) {
      if (!line.includes('"response_item"')) {
        continue;
      }
      const record = parseJsonLine(line);
      if (!record) {
        continue;
      }
      const time = formatTime(epochToMs(record.timestamp)).slice(5);
      for (const part of codexLineParts(record)) {
        items.push({ prefix: `[${time}]`, kind: part.kind, text: clip(part.text, Math.max(textLimit, MULTI_ITEM_TEXT_CHARS)) });
      }
    }
    return items;
  })();
}

async function readClaudeItems(file: string, textLimit: number): Promise<ReadItem[]> {
  const items: ReadItem[] = [];
  for await (const line of streamLines(file)) {
    if (!lineMayMatch("claude", line)) {
      continue;
    }
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }
    const time = formatTime(epochToMs(record.timestamp)).slice(5);
    for (const part of claudeLineParts(record)) {
      const cap = part.kind === "tool" ? 200 : Math.max(textLimit, MULTI_ITEM_TEXT_CHARS);
      items.push({ prefix: `[${time}]`, kind: part.kind, text: clip(part.text, cap) });
    }
  }
  return items;
}

function renderOffsetPage(
  oldestFirst: ReadItem[],
  options: { offset: number; limit: number; budget: number; textLimit: number }
): { body: BoundedOutput; shown: number; nextCursor: string | null; total: number } {
  const total = oldestFirst.length;
  const end = Math.max(0, total - options.offset);
  const start = Math.max(0, end - options.limit);
  const newestFirst = oldestFirst.slice(start, end).reverse();
  const { output, shown } = renderNewestLast(newestFirst, options.budget, options.textLimit);
  const consumed = options.offset + shown;
  return { body: output, shown, nextCursor: consumed < total ? encodeCursor({ r: consumed }) : null, total };
}

export async function readChat(ctx: BridgeContext, args: ReadChatArgs = {}): Promise<string> {
  const source = parseSource(args.source, false) as ChatSource;
  const limit = clampInt(args.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
  const budget = clampBudget(args.budgetChars);
  // One item gets the whole budget, so a caller can fetch a full message.
  const textLimit = limit === 1 ? budget - NOTICE_RESERVE_CHARS - 40 : MULTI_ITEM_TEXT_CHARS;
  const turnId = asString(args.turnId)?.trim() || null;
  if (turnId && !CODEX_ID_PATTERN.test(turnId)) {
    throw new BridgeInputError("Invalid turnId.");
  }
  const state = decodeCursor(args.cursor) ?? {};
  const footer: string[] = [];

  if (source === "claude") {
    const { id, file } = resolveClaudeFile(ctx, args.id);
    const items = await readClaudeItems(file, textLimit);
    const page = renderOffsetPage(items, { offset: cursorNumber(state.r), limit, budget, textLimit });
    if (turnId) {
      footer.push("(turnId applies to Codex chats only; ignored.)");
    }
    return finishRead(`Claude chat ${id}`, page.body, page.shown, page.total, page.nextCursor, budget, footer);
  }

  const id = validateCodexId(args.id);
  try {
    const result = await readCodexViaAppServer(ctx, { id, turnId, limit, state, textLimit });
    const { output, shown } = renderNewestLast(result.newestFirst, budget, textLimit);
    let nextCursor: string | null = null;
    if (result.mode === "turns") {
      nextCursor = result.apiNext || shown < result.newestFirst.length ? encodeCursor({ m: "turns", s: result.skip + shown }) : null;
    } else {
      // Resume right after the last raw entry shown (or scanned, when the
      // whole page was shown), within the same API page when possible.
      const resumeAt =
        shown < result.newestFirst.length
          ? shown === 0
            ? result.rawIndexes[0]
            : result.rawIndexes[shown - 1] + 1
          : result.newestFirst.length === limit
            ? result.rawIndexes[shown - 1] + 1
            : result.rawCount;
      if (resumeAt < result.rawCount) {
        nextCursor = encodeCursor({ a: result.apiCursor, s: resumeAt });
      } else if (result.apiNext) {
        nextCursor = encodeCursor({ a: result.apiNext, s: 0 });
      }
    }
    if (result.mode === "turns") {
      footer.push("(Served via thread/turns/list; this Codex CLI lacks thread/items/list.)");
    }
    return finishRead(`Codex chat ${id}${turnId ? ` turn ${turnId}` : ""}`, output, shown, null, nextCursor, budget, footer);
  } catch (error) {
    if (error instanceof BridgeInputError) {
      throw error;
    }
    // App-server unavailable or the thread is unknown to it: fall back to the
    // rollout file on disk when one exists.
    const rollout = findCodexRolloutFile(ctx, id);
    if (!rollout) {
      throw error;
    }
    if (turnId) {
      footer.push("(turnId ignored in rollout-file fallback.)");
    }
    footer.push(`(Served from the rollout file; app-server error: ${oneLine(error instanceof Error ? error.message : error, 160)})`);
    const items = await readCodexRolloutItems(rollout, textLimit);
    const page = renderOffsetPage(items, { offset: cursorNumber(state.r), limit, budget, textLimit });
    return finishRead(`Codex chat ${id}`, page.body, page.shown, page.total, page.nextCursor, budget, footer);
  }
}

function finishRead(
  title: string,
  body: BoundedOutput,
  shown: number,
  total: number | null,
  nextCursor: string | null,
  budget: number,
  extra: string[]
): string {
  const header = [`${title}: ${shown}${total != null ? ` of ${total}` : ""} items, oldest first, newest last.`];
  const footer = [...extra];
  if (shown === 0) {
    footer.push("No items.");
  }
  if (body.truncated) {
    footer.push(
      `Output truncated at ${budget} chars; raise budgetChars (max ${MAX_BUDGET_CHARS})${shown > 1 ? " or use limit 1 for one full item" : ""}.`
    );
  }
  if (nextCursor) {
    footer.push(`Older items: call again with cursor "${nextCursor}".`);
  }
  return body.render(header, footer);
}

// --- list_running ------------------------------------------------------------------------

export interface ListRunningArgs {
  includeStale?: unknown;
  budgetChars?: unknown;
}

interface RunningJob {
  job: JsonObject;
  stateDir: string;
  updatedMs: number;
}

function jobKindLabel(job: JsonObject): string {
  return asString(job.kindLabel) ?? asString(job.kind) ?? asString(job.jobClass) ?? "job";
}

const QUEUED_WITHOUT_PID_STALE_MS = 15 * 60 * 1000;

/**
 * A running job always records its worker pid (runTrackedJob); a queued job
 * gets one within seconds. Dead pids, pid-less running jobs, and long
 * pid-less queued jobs are stale records, not live work.
 */
function isStaleJob(job: JsonObject, alive: boolean | null, nowMs = Date.now()): boolean {
  if (alive === false) {
    return true;
  }
  if (alive === null) {
    if (job.status === "running") {
      return true;
    }
    const updated = Date.parse(String(job.updatedAt ?? job.createdAt ?? ""));
    return !Number.isFinite(updated) || nowMs - updated > QUEUED_WITHOUT_PID_STALE_MS;
  }
  return false;
}

export function listRunningJobs(ctx: BridgeContext, args: ListRunningArgs = {}): string {
  const budget = clampBudget(args.budgetChars);
  const found: RunningJob[] = [];
  const seen = new Set<string>();
  for (const stateRoot of ctx.roots.stateRoots) {
    for (const entry of safeReaddir(stateRoot)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const stateDir = path.join(stateRoot, entry.name);
      let jobs: unknown[] = [];
      try {
        const stateFile = assertUnderRoot(stateRoot, path.join(entry.name, "state.json"));
        const parsed = asObject(JSON.parse(fs.readFileSync(stateFile, "utf8")));
        jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      } catch {
        continue;
      }
      for (const value of jobs) {
        const job = asObject(value);
        const id = asString(job?.id);
        if (!job || !id || (job.status !== "running" && job.status !== "queued") || seen.has(id)) {
          continue;
        }
        seen.add(id);
        found.push({ job, stateDir, updatedMs: Date.parse(String(job.updatedAt ?? "")) || 0 });
      }
    }
  }
  found.sort((left, right) => right.updatedMs - left.updatedMs);

  const includeStale = args.includeStale === true;
  const output = new BoundedOutput(budget);
  let staleHidden = 0;
  let listed = 0;
  for (const { job, stateDir } of found) {
    const pid = Number(job.pid);
    const alive = Number.isFinite(pid) && pid > 0 ? isProcessAlive(pid) : null;
    if (!includeStale && isStaleJob(job, alive)) {
      // The worker is gone (or never recorded), so the record can never
      // finish on its own; the companion's status/alerts commands reap it.
      // Read-only here: just skip it.
      staleHidden += 1;
      continue;
    }
    listed += 1;
    const phase = asString(job.phase);
    const parts = [
      String(job.id),
      jobKindLabel(job),
      `${job.status}${phase && phase !== job.status ? `/${phase}` : ""}`,
      asString(job.model) ?? "default model",
      `elapsed ${formatElapsed(job.startedAt ?? job.createdAt)}`
    ];
    if (alive !== null) {
      parts.push(`pid ${pid}${alive ? "" : " (dead; stale record)"}`);
    }
    if (job.threadId) {
      parts.push(`thread ${job.threadId}`);
    }
    const lastActivity = asObject(job.lastActivity);
    const activityText = asString(lastActivity?.text) ?? asString(job.summary) ?? asString(job.title);
    const lines = [
      parts.join(" | "),
      `  last: ${activityText ? oneLine(activityText, 160) : "(none)"}${lastActivity?.timestamp ? ` (${lastActivity.timestamp})` : ""}`,
      `  log: ${asString(job.logFile) ?? "(none)"}`,
      `  workspace: ${asString(job.workspaceRoot) ?? asString(job.cwd) ?? stateDir}`
    ];
    if (!output.add(lines.join("\n"))) {
      break;
    }
  }

  const header = [`Running or queued codex-fable jobs across all workspaces: ${listed}.`];
  const footer: string[] = [];
  if (staleHidden > 0) {
    footer.push(`${staleHidden} stale record(s) (dead or missing worker pid) hidden; pass includeStale to show them.`);
  }
  if (listed === 0) {
    footer.push(`No running jobs. State roots checked: ${ctx.roots.stateRoots.join(", ")}`);
  }
  if (output.truncated) {
    footer.push(`Output truncated at ${budget} chars; raise budgetChars (max ${MAX_BUDGET_CHARS}).`);
  }
  return output.render(header, footer);
}
