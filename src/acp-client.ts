import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type {
  AcpContentBlock,
  AcpInitializeResult,
  AcpJsonRpcMessage,
  AcpPromptResult,
  AcpRequestPermissionParams,
  AcpSessionNewResult,
  AcpSessionUpdate,
  AcpSetConfigResult,
  DevinMode,
  ProxyConfig,
} from "./types.js";

const CLIENT_INFO = {
  name: "ai-proxy",
  title: "AI Proxy",
  version: "1.4.0",
} as const;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }

  get isSessionNotFound(): boolean {
    return (
      (this.code === -32016 && this.data?.["cognition.ai/errorKind"] === "session_not_found") ||
      this.code === -32002 ||
      (this.code === -32602 && /session not found/i.test(this.message))
    );
  }

  get isAuthError(): boolean {
    return this.code === -32000;
  }
}

interface PendingRpcCall {
  child: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: unknown) => void;
}

export interface AcpClientEvents {
  exit: [error: Error];
  sessionUpdate: [payload: { sessionId: string; update: AcpSessionUpdate }];
}

export interface AcpEndpointOptions {
  label?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  authMethodIds?: string[];
  supportsCloseSession?: boolean;
  closeForceMeta?: boolean;
}

/**
 * Persistent JSON-RPC 2.0 over stdio client for ACP-compatible CLIs
 * (Devin, Antigravity, OpenCode, Grok).
 */
export class AcpClient extends EventEmitter<AcpClientEvents> {
  readonly #config: ProxyConfig;
  readonly #endpoint: AcpEndpointOptions;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #rl: Interface | null = null;
  #nextId = 1;
  readonly #pending = new Map<string | number, PendingRpcCall>();
  #readyPromise: Promise<AcpInitializeResult> | null = null;
  #initResult: AcpInitializeResult | null = null;
  #stopping = false;
  #permissionMode: DevinMode;

  constructor(config: ProxyConfig, endpoint: AcpEndpointOptions = {}) {
    super();
    this.#config = config;
    this.#endpoint = endpoint;
    this.#permissionMode = config.mode;
  }

  get label(): string {
    return this.#endpoint.label ?? "Devin";
  }

  get isReady(): boolean {
    return this.#proc !== null && this.#proc.exitCode === null && this.#initResult !== null;
  }

  get initializeResult(): AcpInitializeResult | null {
    return this.#initResult;
  }

  setPermissionMode(mode: DevinMode): void {
    this.#permissionMode = mode;
  }

  async ensureReady(): Promise<AcpInitializeResult> {
    if (this.isReady && this.#initResult) return this.#initResult;
    if (this.#readyPromise) return this.#readyPromise;

    this.#readyPromise = this.#startAndInitialize().finally(() => {
      this.#readyPromise = null;
    });
    return this.#readyPromise;
  }

  async #startAndInitialize(): Promise<AcpInitializeResult> {
    this.#stopping = false;
    const executable = this.#endpoint.executable ?? this.#config.devinPath;
    const args = this.#endpoint.args ?? this.#config.acpArgs ?? ["acp", "--process-model", this.#config.processModel];
    if (this.#config.debug) {
      console.error(`[acp:${this.label}] spawning ${executable} ${args.join(" ")}`);
    }

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (this.#endpoint.env) {
      for (const [k, v] of Object.entries(this.#endpoint.env)) {
        if (v === undefined) delete spawnEnv[k];
        else spawnEnv[k] = v;
      }
    }

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: spawnEnv,
    });

    this.#proc = child;
    this.#initResult = null;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#rl = rl;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: AcpJsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as AcpJsonRpcMessage;
      } catch {
        if (this.#config.debug) console.error(`[acp:${this.label}] non-json stdout:`, trimmed.slice(0, 300));
        return;
      }
      this.#handleMessage(child, msg);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#config.debug) {
        process.stderr.write(`[${this.label} stderr] ${chunk.toString("utf8")}`);
      }
    });

    child.on("error", (err) => {
      this.#handleProcessClose(child, err);
    });

    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.#handleProcessClose(child, new Error(`${this.label} acp exited (${reason})`));
    });

    const init = (await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      },
      this.#config.startupTimeoutMs,
    )) as unknown as AcpInitializeResult;

    if (this.#endpoint.authMethodIds && this.#endpoint.authMethodIds.length > 0) {
      const advertised = new Set((init.authMethods ?? []).map((m) => m.id));
      const selectedAuth = this.#endpoint.authMethodIds.find((id) => advertised.has(id));
      if (selectedAuth) {
        await this.request("authenticate", { methodId: selectedAuth }, this.#config.startupTimeoutMs);
      }
    }

    this.#initResult = init;
    return init;
  }

  #handleProcessClose(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#proc === child) {
      this.#proc = null;
      this.#initResult = null;
      this.#rl?.close();
      this.#rl = null;
    }
    for (const [id, entry] of this.#pending) {
      if (entry.child === child) {
        clearTimeout(entry.timer);
        this.#pending.delete(id);
        entry.reject(error);
      }
    }
    if (!this.#stopping) {
      this.emit("exit", error);
    }
  }

  #handleMessage(child: ChildProcessWithoutNullStreams, msg: AcpJsonRpcMessage): void {
    if (!msg || typeof msg !== "object") return;

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(msg.id);
      if (msg.error) {
        entry.reject(
          new AcpRpcError(msg.error.code ?? -32603, msg.error.message ?? "ACP error", msg.error.data),
        );
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      this.#handleServerRequest(child, msg);
      return;
    }

    if (msg.method === "session/update" && msg.params) {
      const sessionId = msg.params.sessionId;
      const update = msg.params.update as AcpSessionUpdate | undefined;
      if (typeof sessionId === "string" && update && typeof update === "object") {
        this.emit("sessionUpdate", { sessionId, update });
      }
    }
  }

  #handleServerRequest(child: ChildProcessWithoutNullStreams, msg: AcpJsonRpcMessage): void {
    let result: Record<string, unknown> = {};
    if (msg.method === "session/request_permission") {
      result = this.#pickPermissionOutcome((msg.params ?? {}) as AcpRequestPermissionParams);
    } else if (msg.method === "session/create_elicitation") {
      result = { action: "decline" };
    }

    if (this.#proc === child && child.stdin.writable && msg.id !== undefined) {
      this.#writeJson(child, { jsonrpc: "2.0", id: msg.id, result });
    }
  }

  #pickPermissionOutcome(params: AcpRequestPermissionParams): Record<string, unknown> {
    const options = Array.isArray(params.options) ? params.options : [];
    const allow = this.#permissionMode !== "ask";
    if (allow) {
      const preferred =
        options.find((opt) => opt.kind === "allow_always") ??
        options.find((opt) => opt.kind === "allow_once") ??
        options[0];
      if (preferred?.optionId) {
        return { outcome: { outcome: "selected", optionId: preferred.optionId } };
      }
    } else {
      const reject =
        options.find((opt) => opt.kind === "reject_once") ??
        options.find((opt) => opt.kind === "reject_always");
      if (reject?.optionId) {
        return { outcome: { outcome: "selected", optionId: reject.optionId } };
      }
    }
    return { outcome: { outcome: "cancelled" } };
  }

  #writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.#config.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const child = this.#proc;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error(`${this.label} ACP process is not running.`));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("ACP request aborted"));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.label} ACP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("ACP request aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#pending.set(id, {
        child,
        timer,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });

      try {
        this.#writeJson(child, { jsonrpc: "2.0", id, method, params });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  async newSession({ cwd, mcpServers = [] }: { cwd: string; mcpServers?: unknown[] }): Promise<AcpSessionNewResult> {
    await this.ensureReady();
    return (await this.request(
      "session/new",
      { cwd, mcpServers },
      this.#config.startupTimeoutMs,
    )) as unknown as AcpSessionNewResult;
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpSetConfigResult> {
    await this.ensureReady();
    return (await this.request(
      "session/set_config_option",
      { sessionId, configId, value },
      15_000,
    )) as unknown as AcpSetConfigResult;
  }

  async prompt(
    sessionId: string,
    promptBlocks: AcpContentBlock[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpPromptResult> {
    await this.ensureReady();
    return (await this.request(
      "session/prompt",
      { sessionId, prompt: promptBlocks },
      options.timeoutMs ?? this.#config.requestTimeoutMs,
      options.signal,
    )) as unknown as AcpPromptResult;
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.isReady) return;
    try {
      await this.request("session/cancel", { sessionId }, 5_000);
    } catch {
      // Best-effort cancellation
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.isReady || this.#endpoint.supportsCloseSession === false) return;
    try {
      const params: Record<string, unknown> = this.#endpoint.closeForceMeta !== false
        ? { sessionId, _meta: { "cognition.ai/force": true } }
        : { sessionId };
      await this.request("session/close", params, 5_000);
    } catch {
      // Best-effort forced close
    }
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    const child = this.#proc;
    this.#proc = null;
    this.#initResult = null;
    this.#rl?.close();
    this.#rl = null;

    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // Ignore
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
        resolve();
      }, 1_500);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}
