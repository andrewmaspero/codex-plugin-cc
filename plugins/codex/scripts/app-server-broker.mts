#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mts";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mts";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mts";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function extractNotificationTurnId(message) {
  return message.params?.turn?.id ?? message.params?.turnId ?? null;
}

function buildJsonRpcError(code, message, data = undefined) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

// Non-streaming control methods that must reach the app-server while another
// socket owns the active stream. They return compact responses and leave
// stream ownership (and notification routing) untouched.
const CONTROL_METHODS = new Set(["turn/interrupt", "turn/steer", "thread/goal/set", "thread/goal/get", "thread/goal/clear"]);

function isControlRequest(message) {
  return CONTROL_METHODS.has(message?.method);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mts serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), String(options.cwd)) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(String(options["pid-file"])) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  // Turn ids that belong to the active stream: the streaming response's turn id
  // plus every turn/started observed on a stream thread while the stream is
  // owned (the real Codex app-server assigns notification turn ids that differ
  // from the turn/start response id, so both must be tracked).
  let activeStreamTurnIds = null;
  // While a streaming request is in flight, capture turn/started ids for its
  // thread so a turn that starts before the response resolves is not lost.
  let pendingStreamCapture = null;
  const sockets = new Set<net.Socket>();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeStreamTurnIds = null;
    }
  }

  function routeNotification(message) {
    if (message.method === "turn/started") {
      const threadId = message.params?.threadId ?? null;
      const turnId = extractNotificationTurnId(message);
      if (threadId && turnId) {
        if (pendingStreamCapture?.threadIds.has(threadId)) {
          pendingStreamCapture.turnIds.add(turnId);
        } else if (activeStreamSocket && activeStreamThreadIds?.has(threadId)) {
          activeStreamTurnIds?.add(turnId);
        }
      }
    }

    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      const turnId = extractNotificationTurnId(message);
      const threadMatches = !threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId);
      // The Codex app-server interleaves server-initiated turns (goal
      // evaluation, auto-compaction) on the same thread. Their turn/completed
      // must NOT release stream ownership, or every event of the client's own
      // still-pending turn is dropped (observed: continue jobs logging nothing
      // after "Thread ready" while their turn ran to completion invisibly).
      const turnMatches = !turnId || !activeStreamTurnIds || activeStreamTurnIds.size === 0 || activeStreamTurnIds.has(turnId);
      if (threadMatches && turnMatches) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeStreamTurnIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        // turn/interrupt and turn/steer are control requests that must reach
        // the app-server while another socket owns the active stream: both are
        // non-streaming, return a compact response, and leave stream ownership
        // (and notification routing) untouched.
        const allowControlDuringActiveStream =
          isControlRequest(message) &&
          activeStreamSocket &&
          activeStreamSocket !== socket &&
          !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowControlDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowControlDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        if (isStreaming) {
          pendingStreamCapture = {
            threadIds: buildStreamThreadIds(message.method, message.params ?? {}, null),
            turnIds: new Set()
          };
        }

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            activeStreamTurnIds = pendingStreamCapture?.turnIds ?? new Set();
            if (result?.turn?.id) {
              activeStreamTurnIds.add(result.turn.id);
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        } finally {
          if (isStreaming) {
            pendingStreamCapture = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
