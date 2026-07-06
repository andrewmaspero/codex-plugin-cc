import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponse,
  ClientInfo,
  CodexAppServerClientOptions,
  InitializeCapabilities
} from "./app-server-protocol.d.ts";
import { parseBrokerEndpoint } from "./broker-endpoint.mts";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mts";
import { terminateProcessTree } from "./process.mts";

type ProtocolError = Error & { data?: unknown; rpcCode?: number };
type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  method: AppServerMethod | string;
};

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const DISABLE_TURN_HOOK_ENV = "CODEX_COMPANION_DISABLE_TURN_HOOK";

const TURN_COMPLETE_HOOK_URL = new URL("../turn-complete-hook.mts", import.meta.url);

/**
 * `-c notify=[...]` argv for `codex app-server`: codex invokes the plugin's
 * turn-complete hook with an agent-turn-complete payload whenever a turn
 * finishes, making job finalization durable even if the worker process dies
 * or its event stream drops (see scripts/turn-complete-hook.mts).
 */
export function buildTurnCompleteNotifyArgs(execPath = process.execPath) {
  const hookPath = fileURLToPath(TURN_COMPLETE_HOOK_URL);
  return ["-c", `notify=[${JSON.stringify(execPath)},${JSON.stringify(hookPath)}]`];
}

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  // Required for the experimental `thread/turns/list` / `thread/items/list`
  // read APIs used by the token-efficient thread viewer commands.
  experimentalApi: true,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data = undefined) {
  return data === undefined ? { code, message } : { code, message, data };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createProtocolError(message, data = undefined): ProtocolError {
  const error: ProtocolError = new Error(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  cwd: string;
  options: any;
  pending: Map<number, PendingRequest>;
  nextId: number;
  stderr: string;
  closed: boolean;
  exitError: Error | null;
  notificationHandler: AppServerNotificationHandler | null;
  lineBuffer: string;
  transport: string;
  exitPromise: Promise<void>;
  resolveExit!: (value: void) => void;
  exitResolved?: boolean;
  proc?: any;
  readline?: readline.Interface;
  socket?: net.Socket;
  endpoint?: string;
  turnCompleteHookEnabled?: boolean;

  constructor(cwd: string, options: CodexAppServerClientOptions & Record<string, any> = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request<M extends AppServerMethod>(method: M, params: AppServerRequestParams<M>): Promise<AppServerResponse<M>> {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params: any = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message as AppServerNotification);
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error = undefined) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd: string, options: CodexAppServerClientOptions & Record<string, any> = {}) {
    super(cwd, options);
    this.transport = "direct";
    const env = options.env ?? process.env;
    this.turnCompleteHookEnabled = !options.disableTurnCompleteHook && !env?.[DISABLE_TURN_HOOK_ENV];
  }

  async initialize() {
    const args = ["app-server", ...(this.turnCompleteHookEnabled ? buildTurnCompleteNotifyArgs() : [])];
    this.proc = spawn("codex", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await withTimeout(
      this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }),
      30000,
      "Timed out waiting for codex app-server to initialize."
    );
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd: string, options: CodexAppServerClientOptions & Record<string, any> = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await withTimeout(
      this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      }),
      5000,
      "Timed out waiting for the shared Codex broker to respond."
    );
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options: any = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    if (brokerEndpoint) {
      const client = new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint });
      await client.initialize();
      return client;
    }

    const client = new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      // Older codex CLIs may reject `-c` overrides on app-server: fall back to
      // a plain spawn (losing the turn-complete hook, not the whole runtime).
      if (!client.turnCompleteHookEnabled) {
        throw error;
      }
      await client.close().catch(() => {});
      const fallback = new SpawnedCodexAppServerClient(cwd, { ...options, disableTurnCompleteHook: true });
      await fallback.initialize();
      return fallback;
    }
  }
}
