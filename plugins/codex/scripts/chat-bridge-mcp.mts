#!/usr/bin/env node
/**
 * Read-only "chat bridge" MCP server over stdio (newline-delimited JSON-RPC
 * 2.0, implemented by hand: the plugin cache ships no node_modules).
 *
 * Tools: list_chats, search_chats, read_chat, list_running. See
 * lib/chat-bridge.mts for behaviour and the security model. Nothing is ever
 * written to stdout except JSON-RPC messages.
 */
import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";

import {
  BridgeInputError,
  DEFAULT_BUDGET_CHARS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_BUDGET_CHARS,
  MAX_LIST_LIMIT,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  listChats,
  listRunningJobs,
  readChat,
  redactSecrets,
  resolveBridgeContext,
  searchChats
} from "./lib/chat-bridge.mts";
import type { BridgeContext } from "./lib/chat-bridge.mts";

const SERVER_NAME = "codex-chat-bridge";
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const SERVER_VERSION: string = PLUGIN_MANIFEST.version ?? "0.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: BridgeContext, args: Record<string, unknown>) => Promise<string> | string;
}

const budgetProperty = {
  type: "integer",
  minimum: 500,
  maximum: MAX_BUDGET_CHARS,
  description: `Max output characters (default ${DEFAULT_BUDGET_CHARS}, hard max ${MAX_BUDGET_CHARS}).`
};

const cwdProperty = { type: "string", description: "Only chats whose working directory is exactly this absolute path." };

const TOOLS: ToolDefinition[] = [
  {
    name: "list_chats",
    title: "List Codex and Claude chats",
    description:
      "List recent Codex chats (via codex app-server thread/list) and Claude Code chats (from ~/.claude/projects), newest first, as compact one-line rows: source | id | updated | cwd | model | title. Codex search matches titles and user prompts only; use search_chats for full text. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["codex", "claude", "all"], default: "all" },
        search: { type: "string", description: "Case-insensitive substring of the title or user prompt." },
        cwd: cwdProperty,
        includeSubagents: { type: "boolean", default: false, description: "Include Codex subagent threads and Claude subagent transcripts." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT },
        cursor: { type: "string", description: "Cursor from a previous list_chats call." },
        budgetChars: budgetProperty
      },
      additionalProperties: false
    },
    run: (ctx, args) => listChats(ctx, args)
  },
  {
    name: "search_chats",
    title: "Full-text search over chats",
    description:
      "Case-insensitive plain-substring search over Codex rollout files (~/.codex/sessions) and Claude Code transcripts, newest chats first, stopping at the limit. Matches user and assistant messages (tool calls with includeTools). Returns chat id, source, time, and a ~200-char snippet per match. Read-only; secrets in snippets are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain text to find (not a regex)." },
        source: { type: "string", enum: ["codex", "claude", "all"], default: "all" },
        cwd: cwdProperty,
        includeSubagents: { type: "boolean", default: false },
        includeTools: { type: "boolean", default: false, description: "Also match tool-call inputs and tool results." },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
        budgetChars: budgetProperty
      },
      required: ["query"],
      additionalProperties: false
    },
    run: (ctx, args) => searchChats(ctx, args)
  },
  {
    name: "read_chat",
    title: "Read one chat",
    description:
      "Read a Codex or Claude chat as compact items (user / assistant / tool name plus a short summary), newest last, within a char budget. Codex reads use app-server thread/items/list (falling back to thread/turns/list, then the rollout file). Use cursor to page to older items; limit 1 returns one item with the whole budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Chat id from list_chats or search_chats." },
        source: { type: "string", enum: ["codex", "claude"] },
        turnId: { type: "string", description: "Codex only: restrict to one turn." },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT, default: DEFAULT_READ_LIMIT },
        cursor: { type: "string", description: "Cursor from a previous read_chat call (older items)." },
        budgetChars: budgetProperty
      },
      required: ["id", "source"],
      additionalProperties: false
    },
    run: (ctx, args) => readChat(ctx, args)
  },
  {
    name: "list_running",
    title: "List running Codex jobs",
    description:
      "List running or queued codex-fable background jobs across all workspaces from the plugin's job state: job id, kind, status, model, elapsed, last activity, log file path. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        includeStale: { type: "boolean", default: false, description: "Also show stale records whose worker pid is dead or missing." },
        budgetChars: budgetProperty
      },
      additionalProperties: false
    },
    run: (ctx, args) => listRunningJobs(ctx, args)
  }
];

const INSTRUCTIONS =
  "Read-only bridge to Codex and Claude Code chat history. Use list_chats to find chats, search_chats for full-text search, read_chat to read one chat, and list_running for running codex-fable jobs. Outputs are bounded; follow the returned cursors for more.";

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sendError(id: JsonRpcId, code: number, message: string) {
  send({ id, error: { code, message } });
}

function toolList() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }));
}

async function callTool(ctx: BridgeContext, params: Record<string, unknown>) {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return { error: { code: -32602, message: `Unknown tool: ${name || "(missing)"}` } };
  }
  const rawArgs = params.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  try {
    const text = await tool.run(ctx, args);
    return { result: { content: [{ type: "text", text }], isError: false } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof BridgeInputError ? "Invalid request" : `${name} failed`;
    return { result: { content: [{ type: "text", text: redactSecrets(`${prefix}: ${message}`).slice(0, 2000) }], isError: true } };
  }
}

async function handleMessage(ctx: BridgeContext, message: JsonRpcMessage) {
  const hasId = message.id !== undefined && message.id !== null;
  const id = hasId ? message.id : null;
  if (typeof message.method !== "string") {
    // A response to a server-initiated request (we never send any) or junk.
    if (hasId && !("result" in message) && !("error" in message)) {
      sendError(id, -32600, "Invalid request.");
    }
    return;
  }
  const params = message.params && typeof message.params === "object" ? message.params : {};

  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      send({
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "Codex Chat Bridge", version: SERVER_VERSION },
          instructions: INSTRUCTIONS
        }
      });
      return;
    }
    case "ping":
      if (hasId) {
        send({ id, result: {} });
      }
      return;
    case "tools/list":
      send({ id, result: { tools: toolList() } });
      return;
    case "tools/call": {
      const outcome = await callTool(ctx, params);
      if (hasId) {
        send({ id, ...outcome });
      }
      return;
    }
    default:
      if (message.method.startsWith("notifications/")) {
        return;
      }
      if (hasId) {
        sendError(id, -32601, `Method not found: ${message.method}`);
      }
  }
}

function main() {
  const ctx = resolveBridgeContext(process.env);
  const pending = new Set<Promise<void>>();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  input.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      sendError(null, -32700, "Parse error.");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      sendError(null, -32600, "Invalid request: expected a single JSON-RPC object.");
      return;
    }
    const task = handleMessage(ctx, message as JsonRpcMessage).catch((error) => {
      process.stderr.write(`[${SERVER_NAME}] ${redactSecrets(String(error?.stack ?? error))}\n`);
      const rpcId = (message as JsonRpcMessage).id;
      if (rpcId !== undefined && rpcId !== null) {
        sendError(rpcId, -32603, "Internal error.");
      }
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  input.on("close", () => {
    Promise.allSettled([...pending]).then(() => process.exit(0));
  });
}

main();
