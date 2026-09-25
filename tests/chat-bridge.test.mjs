import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  MAX_BUDGET_CHARS,
  assertUnderRoot,
  encodeClaudeProjectDir,
  listChats,
  listRunningJobs,
  readChat,
  redactSecrets,
  resolveBridgeContext,
  searchChats
} from "../plugins/codex/scripts/lib/chat-bridge.mts";

const CODEX_ID = "01a0aaaa-0000-7000-8000-000000000001";
const CODEX_OTHER_ID = "01a0aaaa-0000-7000-8000-000000000002";
const CODEX_SUB_ID = "01a0aaaa-0000-7000-8000-000000000003";
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const CLAUDE_OLD_ID = "66666666-2222-4333-8444-555555555555";
const FAKE_OPENAI_KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX";
const FAKE_BEARER = "Bearer abcdefghijklmnop123456";

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function setMtime(file, isoTime) {
  const time = new Date(isoTime);
  fs.utimesSync(file, time, time);
}

function codexRollout(home, { id, cwd, day, source = "vscode", messages, parent = null }) {
  const file = path.join(home, ".codex", "sessions", "2026", "09", day, `rollout-2026-09-${day}T10-00-00-${id}.jsonl`);
  const meta = {
    timestamp: `2026-09-${day}T10:00:00.000Z`,
    type: "session_meta",
    payload: {
      id,
      cwd,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : source,
      base_instructions: { text: "You are Codex. needle-in-instructions should never match." }
    }
  };
  writeJsonl(file, [meta, ...messages]);
  setMtime(file, `2026-09-${day}T12:00:00.000Z`);
  return file;
}

function codexMessage(role, text, minute = 1) {
  return {
    timestamp: `2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] }
  };
}

function claudeLine(type, content, extra = {}) {
  return {
    type,
    message: { role: type, content, ...(type === "assistant" ? { model: "claude-test-model" } : {}) },
    timestamp: extra.timestamp ?? "2026-09-21T09:00:00.000Z",
    cwd: extra.cwd ?? "/work/alpha",
    sessionId: extra.sessionId ?? CLAUDE_ID,
    ...extra
  };
}

function buildFixture() {
  const home = makeTempDir("chat-bridge-");
  const alpha = "/work/alpha";
  const beta = "/work/beta";

  codexRollout(home, {
    id: CODEX_ID,
    cwd: alpha,
    day: "20",
    messages: [
      codexMessage("developer", "needle-in-developer instructions", 0),
      codexMessage("user", "<environment_context>needle-in-context</environment_context>", 1),
      codexMessage("user", "Please find the zebra-needle in the haystack", 2),
      codexMessage("assistant", `Found the zebra-needle. Key was ${FAKE_OPENAI_KEY} in the env.`, 3),
      {
        timestamp: "2026-09-20T10:04:00.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"grep toolonly-needle src"}' }
      }
    ]
  });
  codexRollout(home, {
    id: CODEX_OTHER_ID,
    cwd: beta,
    day: "19",
    messages: [codexMessage("user", "beta zebra-needle prompt", 1)]
  });
  codexRollout(home, {
    id: CODEX_SUB_ID,
    cwd: alpha,
    day: "18",
    parent: CODEX_ID,
    messages: [codexMessage("assistant", "subagent zebra-needle reply", 1)]
  });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ token: "SECRET_AUTH_CONTENT zebra-needle" }));

  const projectDir = path.join(home, ".claude", "projects", encodeClaudeProjectDir(alpha));
  const claudeFile = path.join(projectDir, `${CLAUDE_ID}.jsonl`);
  const items = [
    claudeLine("user", "<system-reminder>injected zebra-needle</system-reminder>", { isMeta: true }),
    claudeLine("user", "Build the llama feature for the zebra-needle project", { timestamp: "2026-09-21T09:00:00.000Z" }),
    claudeLine("assistant", [{ type: "thinking", thinking: "hidden zebra-needle thought" }], { timestamp: "2026-09-21T09:01:00.000Z" }),
    claudeLine("assistant", [{ type: "text", text: `Calling the API with ${FAKE_BEARER} now.` }], { timestamp: "2026-09-21T09:02:00.000Z" }),
    claudeLine("assistant", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls toolonly-needle" } }], {
      timestamp: "2026-09-21T09:03:00.000Z"
    }),
    claudeLine("user", [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "file-a\nfile-b" }] }], {
      timestamp: "2026-09-21T09:04:00.000Z"
    })
  ];
  for (let index = 0; index < 30; index += 1) {
    items.push(
      claudeLine("assistant", [{ type: "text", text: `Progress note ${index}: ${"lorem ipsum ".repeat(20)}` }], {
        timestamp: `2026-09-21T10:${String(index).padStart(2, "0")}:00.000Z`
      })
    );
  }
  items.push(claudeLine("assistant", [{ type: "text", text: "FINAL-ANSWER-MARKER all done." }], { timestamp: "2026-09-21T11:00:00.000Z" }));
  items.push({ type: "custom-title", customTitle: "Llama feature session", sessionId: CLAUDE_ID });
  writeJsonl(claudeFile, items);
  setMtime(claudeFile, "2026-09-21T11:00:00.000Z");

  const oldFile = path.join(projectDir, `${CLAUDE_OLD_ID}.jsonl`);
  writeJsonl(oldFile, [
    claudeLine("user", "An older question about otters", { sessionId: CLAUDE_OLD_ID, timestamp: "2026-09-01T09:00:00.000Z" }),
    { type: "ai-title", aiTitle: "Otter research", sessionId: CLAUDE_OLD_ID }
  ]);
  setMtime(oldFile, "2026-09-01T09:00:00.000Z");

  const subagentFile = path.join(projectDir, CLAUDE_ID, "subagents", "agent-abc123.jsonl");
  writeJsonl(subagentFile, [claudeLine("user", "Subagent task about zebra-needle", { isSidechain: true, agentId: "abc123" })]);
  fs.writeFileSync(subagentFile.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore", description: "Scan the repo" }));
  setMtime(subagentFile, "2026-09-21T10:30:00.000Z");

  const stateRoot = path.join(home, "plugin-state");
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  const now = new Date().toISOString();
  const workspaceState = path.join(stateRoot, "alpha-0123456789abcdef");
  fs.mkdirSync(workspaceState, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceState, "state.json"),
    JSON.stringify({
      version: 1,
      config: {},
      jobs: [
        {
          id: "task-live",
          kind: "task",
          status: "running",
          phase: "editing",
          pid: process.pid,
          model: "gpt-6-sol",
          createdAt: new Date(Date.now() - 125_000).toISOString(),
          updatedAt: now,
          threadId: "thr_live",
          lastActivity: { text: `Editing with ${FAKE_OPENAI_KEY}`, timestamp: now },
          logFile: path.join(workspaceState, "jobs", "task-live.log"),
          workspaceRoot: alpha
        },
        { id: "task-dead", kind: "task", status: "running", pid: deadPid, updatedAt: now, createdAt: now },
        { id: "task-queued", kind: "review", status: "queued", pid: null, updatedAt: now, createdAt: now },
        { id: "task-done", kind: "task", status: "completed", pid: null, updatedAt: now, createdAt: now }
      ]
    })
  );

  const env = {
    HOME: home,
    PATH: path.join(home, "no-codex-bin"),
    CODEX_CHAT_BRIDGE_STATE_ROOTS: stateRoot
  };
  const ctx = resolveBridgeContext(env);
  return { home, ctx, alpha, beta, projectDir, stateRoot };
}

test("list_chats lists Claude chats with titles, cwd, model, and cursor paging", async () => {
  const { ctx, alpha } = buildFixture();
  const text = await listChats(ctx, { source: "claude" });
  const rows = text.split("\n").filter((line) => line.startsWith("claude |"));
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`^claude \\| ${CLAUDE_ID} \\| 2026-09-21 11:00Z \\| ${alpha} \\| claude-test-model \\| Llama feature session$`));
  assert.match(rows[1], /Otter research/);
  assert.doesNotMatch(text, /agent-abc123/);

  const firstPage = await listChats(ctx, { source: "claude", limit: 1 });
  const cursor = /cursor "([^"]+)"/.exec(firstPage)?.[1];
  assert.ok(cursor, firstPage);
  const secondPage = await listChats(ctx, { source: "claude", limit: 1, cursor });
  assert.match(secondPage, new RegExp(CLAUDE_OLD_ID));
  assert.doesNotMatch(secondPage, new RegExp(CLAUDE_ID));
  assert.doesNotMatch(secondPage, /More chats/);

  const withSubagents = await listChats(ctx, { source: "claude", includeSubagents: true });
  assert.match(withSubagents, new RegExp(`${CLAUDE_ID}/agent-abc123 \\| .* \\| parent=${CLAUDE_ID} \\| \\[Explore\\] Scan the repo`));

  const searched = await listChats(ctx, { source: "claude", search: "OTTERS" });
  assert.match(searched, new RegExp(CLAUDE_OLD_ID));
  assert.doesNotMatch(searched, new RegExp(`${CLAUDE_ID} \\|`));

  const otherCwd = await listChats(ctx, { source: "claude", cwd: "/work/beta" });
  assert.match(otherCwd, /No chats matched/);
});

test("list_chats source all degrades gracefully when codex is unavailable", async () => {
  const { ctx } = buildFixture();
  const text = await listChats(ctx, {});
  assert.match(text, /Codex listing unavailable/);
  assert.match(text, new RegExp(CLAUDE_ID));
});

test("search_chats finds full-text matches in Codex rollouts and Claude transcripts, redacting secrets", async () => {
  const { ctx } = buildFixture();
  const text = await searchChats(ctx, { query: "ZEBRA-needle" });
  assert.match(text, new RegExp(`claude \\| ${CLAUDE_ID} \\| 2026-09-21 09:00Z \\| user \\| Build the llama feature for the zebra-needle project`));
  assert.match(text, new RegExp(`codex \\| ${CODEX_ID} \\| 2026-09-20 10:02Z \\| user \\| Please find the zebra-needle`));
  assert.match(text, new RegExp(`codex \\| ${CODEX_ID} \\| .* \\| assistant \\| Found the zebra-needle\\. Key was sk-\\[REDACTED\\]`));
  assert.match(text, new RegExp(`codex \\| ${CODEX_OTHER_ID}`));
  // Injected context, developer text, thinking, subagents, and auth.json never match.
  assert.doesNotMatch(text, /injected|hidden|subagent zebra|SECRET_AUTH_CONTENT/);
  assert.doesNotMatch(text, new RegExp(FAKE_OPENAI_KEY));
  assert.doesNotMatch(text, new RegExp(CODEX_SUB_ID));

  const withSubagents = await searchChats(ctx, { query: "zebra-needle", includeSubagents: true });
  assert.match(withSubagents, new RegExp(CODEX_SUB_ID));
  assert.match(withSubagents, new RegExp(`${CLAUDE_ID}/agent-abc123`));

  const scoped = await searchChats(ctx, { query: "zebra-needle", cwd: "/work/beta" });
  assert.match(scoped, new RegExp(CODEX_OTHER_ID));
  assert.doesNotMatch(scoped, new RegExp(`${CODEX_ID}|${CLAUDE_ID}`));

  const noTools = await searchChats(ctx, { query: "toolonly-needle" });
  assert.match(noTools, /No matches/);
  const tools = await searchChats(ctx, { query: "toolonly-needle", includeTools: true });
  assert.match(tools, new RegExp(`codex \\| ${CODEX_ID} \\| .* \\| tool \\| exec_command`));
  assert.match(tools, new RegExp(`claude \\| ${CLAUDE_ID} \\| .* \\| tool \\| Bash ls toolonly-needle`));

  const limited = await searchChats(ctx, { query: "zebra-needle", limit: 1 });
  assert.equal(limited.split("\n").filter((line) => / \| (user|assistant) \| /.test(line)).length, 1);
  assert.match(limited, /Stopped at limit 1/);

  const snippet = await searchChats(ctx, { query: "Progress note 7", source: "claude" });
  const snippetLine = snippet.split("\n").find((line) => line.includes("Progress note 7"));
  assert.ok(snippetLine.split(" | ").at(-1).length <= 210, snippetLine);
});

test("read_chat returns Claude items newest last within the budget, with cursor paging", async () => {
  const { ctx } = buildFixture();
  const text = await readChat(ctx, { id: CLAUDE_ID, source: "claude" });
  const lines = text.split("\n");
  assert.match(lines[0], /Claude chat .*: \d+ of 35 items, oldest first, newest last\./);
  const itemLines = lines.filter((line) => line.startsWith("["));
  assert.match(itemLines.at(-1), /assistant: FINAL-ANSWER-MARKER all done\./);
  assert.ok(text.length <= 4000, `length ${text.length}`);
  assert.match(text, /Output truncated at 4000 chars/);
  const cursor = /cursor "([^"]+)"/.exec(text)?.[1];
  assert.ok(cursor);

  const older = await readChat(ctx, { id: CLAUDE_ID, source: "claude", cursor, limit: 100, budgetChars: MAX_BUDGET_CHARS });
  assert.match(older, /user: Build the llama feature/);
  assert.match(older, /tool: Bash ls toolonly-needle/);
  assert.match(older, /tool: result: file-a file-b/);
  assert.match(older, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(older, /FINAL-ANSWER-MARKER|hidden zebra-needle thought|injected zebra/);
  assert.doesNotMatch(older, /Older items/);

  const single = await readChat(ctx, { id: CLAUDE_ID, source: "claude", limit: 1, cursor: Buffer.from(JSON.stringify({ r: 1 })).toString("base64url") });
  assert.match(single, /Progress note 29: lorem ipsum/);
  assert.ok(single.includes("lorem ipsum ".repeat(19).trim()), "single item is not clipped to the multi-item preview");

  const subagent = await readChat(ctx, { id: `${CLAUDE_ID}/agent-abc123`, source: "claude" });
  assert.match(subagent, /user: Subagent task about zebra-needle/);
});

test("read_chat falls back to the Codex rollout file when app-server is unavailable", async () => {
  const { ctx } = buildFixture();
  const text = await readChat(ctx, { id: CODEX_ID, source: "codex" });
  assert.match(text, /Served from the rollout file/);
  const itemLines = text.split("\n").filter((line) => line.startsWith("["));
  assert.deepEqual(
    itemLines.map((line) => line.replace(/^\[[^\]]+\] /, "").slice(0, 25)),
    ["user: Please find the zeb", "assistant: Found the zebr", 'tool: exec_command {"cmd"']
  );
  assert.match(text, /sk-\[REDACTED\]/);
  await assert.rejects(readChat(ctx, { id: "01a0ffff-0000-7000-8000-00000000dead", source: "codex" }));
});

test("ids and paths outside the known roots are rejected", async () => {
  const { ctx, home, projectDir } = buildFixture();
  const badClaudeIds = ["../x", `${CLAUDE_ID}/../../x`, "a/../../b", "/etc/passwd", `${CLAUDE_ID}/notagent`, "..", "", "a\\b", "x/./agent-1"];
  for (const id of badClaudeIds) {
    await assert.rejects(readChat(ctx, { id, source: "claude" }), /Invalid Claude/, `id ${JSON.stringify(id)}`);
  }
  for (const id of ["../../auth", "/etc/passwd", "a/b", "auth.json", ""]) {
    await assert.rejects(readChat(ctx, { id, source: "codex" }), /Invalid Codex thread id/, `id ${JSON.stringify(id)}`);
  }
  await assert.rejects(readChat(ctx, { id: CLAUDE_ID, source: "gemini" }), /Invalid source/);
  await assert.rejects(listChats(ctx, { cwd: "relative/path" }), /absolute path/);
  await assert.rejects(readChat(ctx, { id: CLAUDE_ID, source: "claude", cursor: "not-a-cursor!!" }), /Invalid cursor/);

  // A symlinked transcript that points outside the root (at auth.json) is refused.
  fs.symlinkSync(path.join(home, ".codex", "auth.json"), path.join(projectDir, "evil.jsonl"));
  await assert.rejects(readChat(ctx, { id: "evil", source: "claude" }), /symlink/);

  assert.throws(() => assertUnderRoot(ctx.roots.codexSessionsDir, "../auth.json"), /escapes/);
  assert.throws(() => assertUnderRoot(path.join(home, ".codex"), "auth.json"), /credential/);
  assert.equal(assertUnderRoot(ctx.roots.claudeProjectsDir, "p/x.jsonl"), path.join(ctx.roots.claudeProjectsDir, "p", "x.jsonl"));
});

test("list_running shows live jobs across workspaces and hides stale records", () => {
  const { ctx } = buildFixture();
  const text = listRunningJobs(ctx, {});
  assert.match(text, /jobs across all workspaces: 2\./);
  assert.match(text, /task-live \| task \| running\/editing \| gpt-6-sol \| elapsed 2m \d+s \| pid \d+ \| thread thr_live/);
  assert.match(text, /last: Editing with sk-\[REDACTED\]/);
  assert.match(text, /log: .*task-live\.log/);
  assert.match(text, /workspace: \/work\/alpha/);
  assert.match(text, /task-queued \| review \| queued/);
  assert.doesNotMatch(text, /task-dead|task-done/);
  assert.match(text, /1 stale record/);

  const withStale = listRunningJobs(ctx, { includeStale: true });
  assert.match(withStale, /task-dead .*dead; stale record/);

  const empty = listRunningJobs(resolveBridgeContext({ HOME: makeTempDir(), CODEX_CHAT_BRIDGE_STATE_ROOTS: makeTempDir() }), {});
  assert.match(empty, /No running jobs/);
});

test("budgets default to 4000 chars and clamp to the 20000-char hard max", async () => {
  const { ctx, projectDir } = buildFixture();
  for (let index = 0; index < 150; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    writeJsonl(path.join(projectDir, `${id}.jsonl`), [claudeLine("user", `Session ${index} ${"long prompt text ".repeat(20)}`, { sessionId: id })]);
  }
  const small = await listChats(ctx, { source: "claude", limit: 100 });
  assert.ok(small.length <= 4000, `length ${small.length}`);
  assert.match(small, /Output truncated at 4000 chars/);
  assert.match(small, /More chats: call again with cursor/);

  const huge = await listChats(ctx, { source: "claude", limit: 100, budgetChars: 10_000_000 });
  assert.ok(huge.length > 4000 && huge.length <= MAX_BUDGET_CHARS, `length ${huge.length}`);
  assert.doesNotMatch(huge, /Output truncated/);

  const capped = await readChat(ctx, { id: CLAUDE_ID, source: "claude", limit: 1, budgetChars: 10_000_000 });
  assert.ok(capped.length <= MAX_BUDGET_CHARS, `length ${capped.length}`);

  const tiny = await readChat(ctx, { id: CLAUDE_ID, source: "claude", budgetChars: 1 });
  assert.ok(tiny.length <= 500, `length ${tiny.length}`);
});

test("redactSecrets masks common credential shapes", () => {
  const input = [
    `openai ${FAKE_OPENAI_KEY}`,
    `anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz`,
    `header Authorization: ${FAKE_BEARER}`,
    "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "aws AKIAABCDEFGHIJKLMNOP",
    'config {"api_key": "abcdef1234567890"}',
    "export PASSWORD=hunter2hunter2",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "max_tokens: 50000 and total_tokens=123456789 stay"
  ].join("\n");
  const output = redactSecrets(input);
  for (const secret of [
    FAKE_OPENAI_KEY,
    "abcdefghijklmnopqrstuvwxyz",
    "abcdefghijklmnop123456",
    "ghp_",
    "AKIAABCDEFGHIJKLMNOP",
    "abcdef1234567890",
    "hunter2hunter2",
    "eyJhbGci",
    "MIIEow"
  ]) {
    assert.ok(!output.includes(secret), `leaked ${secret} in ${output}`);
  }
  assert.match(output, /max_tokens: 50000 and total_tokens=123456789 stay/);
});
