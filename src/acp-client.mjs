import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const CLIENT_INFO = {
  name: "ai-anthropic-proxy",
  title: "AI-Anthropic-Proxy",
  version: "1.0.0",
};

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export class AcpRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }

  get isSessionNotFound() {
    return (
      (this.code === -32016 && this.data && this.data["cognition.ai/errorKind"] === "session_not_found") ||
      this.code === -32002
    );
  }

  get isAuthError() {
    return this.code === -32000;
  }
}

/**
 * Persistent JSON-RPC 2.0 over stdio client for `devin acp`.
 */
export class AcpClient extends EventEmitter {
  #config;
  #proc = null;
  #rl = null;
  #nextId = 1;
  #pending = new Map();
  #readyPromise = null;
  #initResult = null;
  #stopping = false;
  #permissionMode;

  constructor(config) {
    super();
    this.#config = config;
    this.#permissionMode = config.mode;
  }

  get isReady() {
    return this.#proc !== null && this.#proc.exitCode === null && this.#initResult !== null;
  }

  get initializeResult() {
    return this.#initResult;
  }

  setPermissionMode(mode) {
    this.#permissionMode = mode;
  }

  async ensureReady() {
    if (this.isReady) return this.#initResult;
    if (this.#readyPromise) return this.#readyPromise;

    this.#readyPromise = this.#startAndInitialize().finally(() => {
      this.#readyPromise = null;
    });
    return this.#readyPromise;
  }

  async #startAndInitialize() {
    this.#stopping = false;
    const args = this.#config.acpArgs ?? ["acp", "--process-model", this.#config.processModel];
    if (this.#config.debug) {
      console.error(`[acp] spawning ${this.#config.devinPath} ${args.join(" ")}`);
    }

    const child = spawn(this.#config.devinPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    this.#proc = child;
    this.#initResult = null;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#rl = rl;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        if (this.#config.debug) console.error("[acp] non-json stdout:", trimmed.slice(0, 300));
        return;
      }
      this.#handleMessage(child, msg);
    });

    child.stderr.on("data", (chunk) => {
      if (this.#config.debug) {
        process.stderr.write(`[devin stderr] ${chunk.toString("utf8")}`);
      }
    });

    child.on("error", (err) => {
      this.#handleProcessClose(child, err);
    });

    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.#handleProcessClose(child, new Error(`devin acp exited (${reason})`));
    });

    const init = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      },
      this.#config.startupTimeoutMs,
    );
    this.#initResult = init;
    return init;
  }

  #handleProcessClose(child, error) {
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

  #handleMessage(child, msg) {
    if (!msg || typeof msg !== "object") return;

    // Server response to our request
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new AcpRpcError(msg.error.code ?? -32603, msg.error.message ?? "ACP error", msg.error.data));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    // Server-initiated request (requires JSON-RPC response)
    if (msg.id !== undefined && typeof msg.method === "string") {
      this.#handleServerRequest(child, msg).catch((err) => {
        if (this.#config.debug) console.error("[acp] server request error:", err);
      });
      return;
    }

    // Server notification
    if (msg.method === "session/update" && msg.params?.sessionId && msg.params?.update) {
      this.emit("sessionUpdate", {
        sessionId: msg.params.sessionId,
        update: msg.params.update,
      });
    }
  }

  async #handleServerRequest(child, msg) {
    let result = {};
    if (msg.method === "session/request_permission") {
      result = this.#pickPermissionOutcome(msg.params);
    } else if (msg.method === "session/create_elicitation") {
      result = { action: "decline" };
    }

    if (this.#proc === child && child.stdin.writable) {
      this.#writeJson(child, { jsonrpc: "2.0", id: msg.id, result });
    }
  }

  #pickPermissionOutcome(params) {
    const options = Array.isArray(params?.options) ? params.options : [];
    const allow = this.#permissionMode !== "ask";
    if (allow) {
      const preferred =
        options.find((opt) => opt?.kind === "allow_always") ??
        options.find((opt) => opt?.kind === "allow_once") ??
        options[0];
      if (preferred?.optionId) {
        return { outcome: { outcome: "selected", optionId: preferred.optionId } };
      }
    } else {
      const reject =
        options.find((opt) => opt?.kind === "reject_once") ??
        options.find((opt) => opt?.kind === "reject_always");
      if (reject?.optionId) {
        return { outcome: { outcome: "selected", optionId: reject.optionId } };
      }
    }
    return { outcome: { outcome: "cancelled" } };
  }

  #writeJson(child, payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params = {}, timeoutMs = this.#config.requestTimeoutMs, signal) {
    const child = this.#proc;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error("ACP process is not running."));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("ACP request aborted"));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };

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

  async newSession({ cwd, mcpServers = [] }) {
    await this.ensureReady();
    return this.request("session/new", { cwd, mcpServers }, this.#config.startupTimeoutMs);
  }

  async setConfigOption(sessionId, configId, value) {
    await this.ensureReady();
    return this.request("session/set_config_option", { sessionId, configId, value }, 15_000);
  }

  async prompt(sessionId, promptBlocks, { signal, timeoutMs = this.#config.requestTimeoutMs } = {}) {
    await this.ensureReady();
    return this.request("session/prompt", { sessionId, prompt: promptBlocks }, timeoutMs, signal);
  }

  async cancel(sessionId) {
    if (!this.isReady) return;
    try {
      await this.request("session/cancel", { sessionId }, 5_000);
    } catch {
      // Best-effort cancellation
    }
  }

  async closeSession(sessionId) {
    if (!this.isReady) return;
    try {
      await this.request(
        "session/close",
        { sessionId, _meta: { "cognition.ai/force": true } },
        5_000,
      );
    } catch {
      // Best-effort forced close
    }
  }

  async shutdown() {
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
    await new Promise((resolve) => {
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
