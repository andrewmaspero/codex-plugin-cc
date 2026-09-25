import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "plugins", "codex", "scripts", "chat-bridge-mcp.mts");
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")).version;

function turn(id, prompt, answer, extraItems = []) {
  return {
    id,
    status: "completed",
    startedAt: 1_790_000_000,
    completedAt: 1_790_000_010,
    durationMs: 100,
    error: null,
    items: [
      { type: "userMessage", id: `user_${id}`, content: [{ type: "text", text: prompt }] },
      ...extraItems,
      { type: "agentMessage", id: `msg_${id}`, text: answer, phase: "final_answer" }
    ]
  };
}

function seedFakeCodex(binDir, cwd) {
  const threads = [
    {
      id: "thr_main",
      cwd,
      name: "Main design thread",
      preview: "Design the parser",
      model: "gpt-6-sol",
      reasoningEffort: "high",
      createdAt: 1_790_000_000,
      updatedAt: 1_790_000_300,
      turns: [
        turn("turn_1", "First prompt about parsing", "First answer"),
        turn("turn_2", "Second prompt", "Second answer with token=abcdef1234567890", [
          { type: "reasoning", id: "r_2", summary: [] },
          { type: "commandExecution", id: "cmd_2", status: "completed", exitCode: 0, command: "pnpm test" }
        ])
      ]
    },
    {
      id: "thr_sub",
      cwd,
      name: null,
      preview: "Subagent work",
      model: "gpt-6-luna",
      parentThreadId: "thr_main",
      agentNickname: "Hypatia",
      createdAt: 1_790_000_000,
      updatedAt: 1_790_000_200,
      turns: []
    },
    {
      id: "thr_old",
      cwd: "/elsewhere",
      name: "Old thread",
      preview: "Older work",
      model: "gpt-6-astra",
      createdAt: 1_780_000_000,
      updatedAt: 1_780_000_100,
      turns: [turn("turn_old", "old prompt", "old answer")]
    }
  ];
  fs.writeFileSync(
    path.join(binDir, "fake-codex-state.json"),
    JSON.stringify({ nextThreadId: 10, nextTurnId: 10, appServerStarts: 0, threads, capabilities: null, lastInterrupt: null })
  );
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function setup(behavior = "review-ok") {
  const home = makeTempDir("chat-bridge-mcp-");
  const binDir = makeTempDir("chat-bridge-bin-");
  const workspace = path.join(home, "work");
  fs.mkdirSync(workspace, { recursive: true });
  installFakeCodex(binDir, behavior);
  seedFakeCodex(binDir, workspace);
  const env = {
    ...buildEnv(binDir),
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CODEX_CHAT_BRIDGE_STATE_ROOTS: path.join(home, "state")
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_PLUGIN_DATA;
  return { home, binDir, workspace, env };
}

function startServer(env, cwd) {
  const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  const waiters = new Map();
  const stray = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      } else {
        stray.push(message);
      }
      index = buffer.indexOf("\n");
    }
  });
  let nextId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 20_000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  const callTool = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    assert.equal(response.jsonrpc, "2.0");
    return response.result;
  };
  const stop = () =>
    new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.stdin.end();
    });
  return { child, request, notify, callTool, stop, stray, getStderr: () => stderr };
}

async function handshake(server) {
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" }
  });
  server.notify("notifications/initialized");
  return init;
}

test("MCP handshake: initialize, tools/list, tools/call over stdio", async () => {
  const { env, workspace } = setup();
  const server = startServer(env, workspace);
  try {
    const init = await handshake(server);
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, "codex-chat-bridge");
    assert.equal(init.result.serverInfo.version, PLUGIN_VERSION);

    const ping = await server.request("ping");
    assert.deepEqual(ping.result, {});

    const list = await server.request("tools/list", {});
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ["list_chats", "search_chats", "read_chat", "list_running"]
    );
    for (const tool of list.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.inputSchema.type, "object");
    }

    const running = await server.callTool("list_running", {});
    assert.equal(running.isError, false);
    assert.match(running.content[0].text, /No running jobs/);

    const unknownMethod = await server.request("resources/list", {});
    assert.equal(unknownMethod.error.code, -32601);
    const unknownTool = await server.request("tools/call", { name: "delete_chat", arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    const badArgs = await server.callTool("read_chat", { id: "../../.codex/auth", source: "claude" });
    assert.equal(badArgs.isError, true);
    assert.match(badArgs.content[0].text, /Invalid request: Invalid Claude chat id/);

    const oldProtocol = await server.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "0" } });
    assert.equal(oldProtocol.result.protocolVersion, "2025-06-18");

    server.child.stdin.write("not json\n");
    const code = await server.stop();
    assert.equal(code, 0);
    assert.ok(server.stray.some((message) => message.error?.code === -32700), "parse error reported");
  } finally {
    server.child.kill();
  }
});

test("list_chats and read_chat reach Codex through a direct app-server (thread/list, thread/items/list)", async () => {
  const { env, workspace, binDir } = setup();
  const server = startServer(env, workspace);
  try {
    await handshake(server);
    const listed = await server.callTool("list_chats", { source: "codex" });
    assert.equal(listed.isError, false, listed.content[0].text);
    const text = listed.content[0].text;
    const rows = text.split("\n").filter((line) => line.startsWith("codex |"));
    assert.equal(rows.length, 2, text);
    assert.match(rows[0], new RegExp(`^codex \\| thr_main \\| \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\dZ \\| [^|]*/work \\| gpt-6-sol/high \\| Main design thread$`));
    assert.match(rows[1], /^codex \| thr_old \| .* \| \/elsewhere \| gpt-6-astra \| Old thread$/);

    const state = readFakeState(binDir);
    assert.equal(state.lastThreadList.sortKey, "updated_at");
    assert.deepEqual(state.lastThreadList.sourceKinds, ["cli", "vscode", "exec", "appServer", "unknown"]);
    assert.equal(state.lastAppServerEnv.CODEX_COMPANION_APP_SERVER_ENDPOINT, null, "never routed through a broker");
    assert.ok(!state.lastAppServerArgs.includes("-c"), "no notify hook on the read-only app-server");

    const withSubagents = await server.callTool("list_chats", { source: "codex", includeSubagents: true });
    assert.match(withSubagents.content[0].text, /codex \| thr_sub \| .* \| gpt-6-luna \| parent=thr_main \(Hypatia\) \| Subagent work/);
    assert.ok(readFakeState(binDir).lastThreadList.sourceKinds.includes("subAgentThreadSpawn"));

    const scoped = await server.callTool("list_chats", { source: "codex", cwd: "/elsewhere", search: "Old" });
    assert.match(scoped.content[0].text, /thr_old/);
    assert.doesNotMatch(scoped.content[0].text, /thr_main/);
    assert.equal(readFakeState(binDir).lastThreadList.searchTerm, "Old");

    const page1 = await server.callTool("list_chats", { source: "codex", limit: 1 });
    const cursor = /cursor "([^"]+)"/.exec(page1.content[0].text)?.[1];
    assert.ok(cursor, page1.content[0].text);
    const page2 = await server.callTool("list_chats", { source: "codex", limit: 1, cursor });
    assert.match(page2.content[0].text, /thr_old/);
    assert.doesNotMatch(page2.content[0].text, /thr_main|More chats/);

    const read = await server.callTool("read_chat", { id: "thr_main", source: "codex" });
    assert.equal(read.isError, false, read.content[0].text);
    const items = read.content[0].text.split("\n").filter((line) => line.startsWith("["));
    assert.deepEqual(items, [
      "[turn_1] user: First prompt about parsing",
      "[turn_1] assistant: First answer",
      "[turn_2] user: Second prompt",
      "[turn_2] tool shell [completed exit 0]: pnpm test",
      "[turn_2] assistant: Second answer with token=[REDACTED]"
    ]);
    assert.doesNotMatch(read.content[0].text, /Older items/);

    const newest = await server.callTool("read_chat", { id: "thr_main", source: "codex", limit: 2 });
    assert.deepEqual(
      newest.content[0].text.split("\n").filter((line) => line.startsWith("[")),
      ["[turn_2] tool shell [completed exit 0]: pnpm test", "[turn_2] assistant: Second answer with token=[REDACTED]"]
    );
    const olderCursor = /cursor "([^"]+)"/.exec(newest.content[0].text)?.[1];
    assert.ok(olderCursor);
    const older = await server.callTool("read_chat", { id: "thr_main", source: "codex", limit: 2, cursor: olderCursor });
    assert.deepEqual(
      older.content[0].text.split("\n").filter((line) => line.startsWith("[")),
      ["[turn_1] assistant: First answer", "[turn_2] user: Second prompt"]
    );

    const oneTurn = await server.callTool("read_chat", { id: "thr_main", source: "codex", turnId: "turn_1" });
    assert.deepEqual(
      oneTurn.content[0].text.split("\n").filter((line) => line.startsWith("[")),
      ["[turn_1] user: First prompt about parsing", "[turn_1] assistant: First answer"]
    );
    await server.stop();
  } finally {
    server.child.kill();
  }
});

test("read_chat falls back to thread/turns/list when thread/items/list is unavailable", async () => {
  const { env, workspace } = setup("no-items-list");
  const server = startServer(env, workspace);
  try {
    await handshake(server);
    const read = await server.callTool("read_chat", { id: "thr_main", source: "codex", limit: 3 });
    assert.equal(read.isError, false, read.content[0].text);
    const text = read.content[0].text;
    assert.match(text, /Served via thread\/turns\/list/);
    assert.deepEqual(
      text.split("\n").filter((line) => line.startsWith("[")),
      ["[turn_2] user: Second prompt", "[turn_2] tool shell [completed exit 0]: pnpm test", "[turn_2] assistant: Second answer with token=[REDACTED]"]
    );
    const cursor = /cursor "([^"]+)"/.exec(text)?.[1];
    assert.ok(cursor);
    const older = await server.callTool("read_chat", { id: "thr_main", source: "codex", limit: 3, cursor });
    assert.deepEqual(
      older.content[0].text.split("\n").filter((line) => line.startsWith("[")),
      ["[turn_1] user: First prompt about parsing", "[turn_1] assistant: First answer"]
    );
    await server.stop();
  } finally {
    server.child.kill();
  }
});

test("search_chats and Claude listing work over stdio against temp transcripts", async () => {
  const { env, workspace, home } = setup();
  const projectDir = path.join(home, ".claude", "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = "abcdef01-2345-4678-9abc-def012345678";
  const lines = [
    { type: "user", message: { role: "user", content: "Where is the walrus-token config?" }, cwd: workspace, timestamp: "2026-09-20T01:00:00.000Z" },
    {
      type: "assistant",
      message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "The walrus-token lives in env: Bearer abcdefgh12345678" }] },
      cwd: workspace,
      timestamp: "2026-09-20T01:01:00.000Z"
    }
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const server = startServer(env, workspace);
  try {
    await handshake(server);
    const all = await server.callTool("list_chats", {});
    const text = all.content[0].text;
    assert.match(text, new RegExp(`claude \\| ${sessionId} \\| .* \\| claude-test \\| Where is the walrus-token config\\?`));
    assert.match(text, /codex \| thr_main/);

    const search = await server.callTool("search_chats", { query: "WALRUS-token", source: "claude" });
    const searchText = search.content[0].text;
    assert.match(searchText, new RegExp(`claude \\| ${sessionId} \\| 2026-09-20 01:00Z \\| user \\| Where is the walrus-token config\\?`));
    assert.match(searchText, /assistant \| The walrus-token lives in env: Bearer \[REDACTED\]/);
    assert.doesNotMatch(searchText, /abcdefgh12345678/);

    const read = await server.callTool("read_chat", { id: sessionId, source: "claude", budgetChars: 600 });
    assert.ok(read.content[0].text.length <= 600);
    assert.match(read.content[0].text, /assistant: The walrus-token lives in env: Bearer \[REDACTED\]/);
    await server.stop();
  } finally {
    server.child.kill();
  }
});
