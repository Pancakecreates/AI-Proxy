import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import { normalizeEffortValue, resolveSpeed, resolveThoughtLevel } from "./models.js";
import { extractSystemText, hashSystem, messageFingerprint, normalizeMessageContent } from "./sessions.js";
import type {
  AnthropicMessageParam,
  AnthropicMessagesRequest,
  BackendHealthStatus,
  BackendKind,
  BackendModelEntry,
  DevinModelEntry,
  ProxyBackend,
  ProxyConfig,
  RunTurnCallbacks,
  SpeedMode,
  ThoughtLevel,
  TurnResult,
} from "./types.js";

/// Пока инструмент выполняется (сборка, тесты), Codex законно молчит.
const TOOL_IDLE_FLOOR_MS = 30 * 60_000;

interface CodexPendingCall {
  child: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: unknown) => void;
}

interface CodexRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexModelRecord {
  id: string;
  name: string;
  description?: string;
  supportsImages: boolean;
  supportedEfforts: ThoughtLevel[];
  effortWireValues: Partial<Record<ThoughtLevel, string>>;
  defaultEffort: ThoughtLevel | null;
  supportedSpeeds: SpeedMode[];
}

interface CodexThreadRecord {
  threadId: string;
  cwd: string;
  systemHash: string;
  fingerprints: string[];
  busy: boolean;
  lastUsedAt: number;
}

interface ActiveTurnHandlers {
  threadId: string;
  turnId: string | null;
  assistantText: string;
  commentaryItemIds: Set<string>;
  seenTools: Map<string, { title: string; status: string }>;
  inputTokens: number;
  outputTokens: number;
  onThinking?: (chunk: string) => void;
  onText?: (chunk: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  resolve: (result: { stopReason: TurnResult["stopReason"]; assistantText: string; inputTokens: number; outputTokens: number }) => void;
  reject: (err: Error) => void;
}

export interface CodexBackendOptions {
  executable: string;
  args?: string[];
  label?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function buildCodexUserInput(params: {
  messages: readonly AnthropicMessageParam[];
  supportsImages: boolean;
}): Array<Record<string, unknown>> {
  const { messages, supportsImages } = params;
  const input: Array<Record<string, unknown>> = [];
  const textChunks: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];

  const single = messages.length === 1 ? messages[0] : undefined;
  if (single && single.role === "user") {
    const norm = normalizeMessageContent(single.content);
    if (norm.text) textChunks.push(norm.text);
    images.push(...norm.images);
  } else {
    for (const msg of messages) {
      const norm = normalizeMessageContent(msg.content);
      const label = msg.role === "assistant" ? "Assistant" : "User";
      if (norm.text) textChunks.push(`[${label}]\n${norm.text}`);
      images.push(...norm.images);
    }
  }

  if (images.length > 0 && !supportsImages) {
    textChunks.push(`[${images.length} image attachment(s) omitted because selected model does not support images]`);
  }

  const combinedText = textChunks.join("\n\n").trim() || (images.length > 0 ? "" : "Continue.");
  if (combinedText) {
    input.push({ type: "text", text: combinedText, text_elements: [] });
  }

  if (supportsImages) {
    for (const img of images) {
      input.push({ type: "image", url: `data:${img.mimeType};base64,${img.data}` });
    }
  }

  if (input.length === 0) {
    input.push({ type: "text", text: "Continue.", text_elements: [] });
  }

  return input;
}

function mapCodexSandboxAndApproval(mode: ProxyConfig["mode"]): {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "never";
} {
  if (mode === "ask") return { sandbox: "read-only", approvalPolicy: "on-request" };
  if (mode === "plan") return { sandbox: "read-only", approvalPolicy: "never" };
  if (mode === "accept-edits" || mode === "smart") {
    return { sandbox: "workspace-write", approvalPolicy: "never" };
  }
  return { sandbox: "danger-full-access", approvalPolicy: "never" };
}

function describeCodexTool(item: Record<string, unknown>): string {
  const type = asString(item.type) ?? "tool";
  if (type === "commandExecution") {
    const cmd = asString(item.command);
    return cmd ? `Run ${cmd.slice(0, 80)}` : "Run command";
  }
  if (type === "fileChange") return "Edit files";
  if (type === "mcpToolCall") {
    const server = asString(item.server) ?? "";
    const tool = asString(item.tool) ?? "mcp";
    return server ? `${server}.${tool}` : tool;
  }
  if (type === "webSearch") {
    const q = asString(item.query);
    return q ? `Web search: ${q.slice(0, 60)}` : "Web search";
  }
  if (type === "dynamicToolCall") {
    return asString(item.tool) ?? "Tool call";
  }
  return type;
}

/**
 * ProxyBackend implementation for OpenAI Codex CLI (`codex app-server`).
 */
export class CodexBackend extends EventEmitter implements ProxyBackend {
  readonly key = "codex";
  readonly kind: BackendKind = "codex";
  readonly label: string;
  readonly #config: ProxyConfig;
  readonly #executable: string;
  readonly #args: string[];

  #proc: ChildProcessWithoutNullStreams | null = null;
  #rl: Interface | null = null;
  #nextId = 1;
  readonly #pending = new Map<string | number, CodexPendingCall>();
  #readyPromise: Promise<void> | null = null;
  #initialized = false;
  #stopping = false;
  #lastActivity = Date.now();
  readonly #runningTools = new Set<string>();

  #models: CodexModelRecord[] = [];
  #warmupPromise: Promise<DevinModelEntry[]> | null = null;
  readonly #threads = new Map<string, CodexThreadRecord>();
  readonly #activeTurns = new Map<string, ActiveTurnHandlers>();
  #lastError: string | undefined;

  constructor(config: ProxyConfig, options: CodexBackendOptions) {
    super();
    this.#config = config;
    this.#executable = options.executable;
    this.#args = options.args ?? ["app-server", "--listen", "stdio://"];
    this.label = options.label ?? "Codex";
  }

  get isReady(): boolean {
    return this.#proc !== null && this.#proc.exitCode === null && this.#initialized;
  }

  get activeSessionCount(): number {
    return this.#threads.size;
  }

  async #ensureReady(): Promise<void> {
    if (this.isReady) return;
    if (this.#readyPromise) return this.#readyPromise;

    this.#readyPromise = this.#startAndInitialize().finally(() => {
      this.#readyPromise = null;
    });
    return this.#readyPromise;
  }

  async #startAndInitialize(): Promise<void> {
    this.#stopping = false;
    if (this.#config.debug) {
      console.error(`[codex] spawning ${this.#executable} ${this.#args.join(" ")}`);
    }

    const child = spawn(this.#executable, this.#args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    this.#proc = child;
    this.#initialized = false;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#rl = rl;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: CodexRpcMessage;
      try {
        msg = JSON.parse(trimmed) as CodexRpcMessage;
      } catch {
        if (this.#config.debug) console.error("[codex] non-json stdout:", trimmed.slice(0, 300));
        return;
      }
      this.#handleMessage(child, msg);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#config.debug) {
        process.stderr.write(`[codex stderr] ${chunk.toString("utf8")}`);
      }
    });

    child.on("error", (err) => {
      this.#handleProcessClose(child, err);
    });

    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.#handleProcessClose(child, new Error(`Codex app-server exited (${reason})`));
    });

    await this.#request(
      "initialize",
      {
        clientInfo: { name: "ai-proxy", title: "AI Proxy", version: "1.4.0" },
        capabilities: { experimentalApi: true },
      },
      this.#config.startupTimeoutMs,
    );

    this.#initialized = true;
  }

  #handleProcessClose(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#proc === child) {
      this.#proc = null;
      this.#initialized = false;
      this.#rl?.close();
      this.#rl = null;
      this.#threads.clear();
    }
    for (const [id, entry] of this.#pending) {
      if (entry.child === child) {
        clearTimeout(entry.timer);
        this.#pending.delete(id);
        entry.reject(error);
      }
    }
    this.#runningTools.clear();
    for (const [threadId, active] of this.#activeTurns) {
      this.#activeTurns.delete(threadId);
      active.reject(error);
    }
    if (!this.#stopping) {
      this.emit("exit", error);
    }
  }

  #handleMessage(child: ChildProcessWithoutNullStreams, msg: CodexRpcMessage): void {
    if (!msg || typeof msg !== "object") return;
    this.#lastActivity = Date.now();

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || `Codex RPC error (${msg.error.code ?? -32603})`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.id !== undefined && typeof msg.method === "string") {
      this.#handleServerRequest(child, msg);
      return;
    }

    if (typeof msg.method === "string") {
      this.#handleNotification(msg.method, msg.params ?? {});
    }
  }

  #handleServerRequest(child: ChildProcessWithoutNullStreams, msg: CodexRpcMessage): void {
    const allow = this.#config.mode !== "ask";
    let result: Record<string, unknown> = {};

    if (
      msg.method === "item/commandExecution/requestApproval" ||
      msg.method === "item/fileChange/requestApproval"
    ) {
      result = { decision: allow ? "accept" : "decline" };
    } else if (msg.method === "execCommandApproval" || msg.method === "applyPatchApproval") {
      result = { decision: allow ? "approved" : "denied" };
    } else if (msg.method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else if (msg.method === "mcpServer/elicitation/request") {
      result = { action: "decline" };
    }

    if (this.#proc === child && child.stdin.writable && msg.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
    }
  }

  #trackToolItem(method: string, params: Record<string, unknown>): void {
    if (method !== "item/started" && method !== "item/completed") return;
    const item = asRecord(params.item);
    if (!item) return;
    const itemType = asString(item.type);
    if (!itemType || itemType === "agentMessage" || itemType === "reasoning") return;
    const key = asString(item.id) ?? itemType;
    if (method === "item/started") {
      this.#runningTools.add(key);
    } else {
      this.#runningTools.delete(key);
    }
  }

  #handleNotification(method: string, params: Record<string, unknown>): void {
    this.#trackToolItem(method, params);
    const threadId = asString(params.threadId);
    if (!threadId) return;
    const active = this.#activeTurns.get(threadId);
    if (!active) return;

    if (method === "turn/started") {
      const turn = asRecord(params.turn);
      const turnId = asString(turn?.id);
      if (turnId) active.turnId = turnId;
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      active.onThinking?.("\n\n");
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = asString(params.delta);
      if (delta) active.onThinking?.(delta);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = asString(params.delta);
      const itemId = asString(params.itemId);
      if (!delta) return;
      if (itemId && active.commentaryItemIds.has(itemId)) {
        active.onThinking?.(delta);
      } else {
        active.assistantText += delta;
        active.onText?.(delta);
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (!item) return;
      const itemType = asString(item.type);
      const itemId = asString(item.id) ?? itemType ?? "item";
      if (itemType === "agentMessage") {
        if (asString(item.phase) === "commentary") {
          active.commentaryItemIds.add(itemId);
        } else if (method === "item/completed") {
          const fullText = asString(item.text);
          if (fullText && !active.assistantText) {
            active.assistantText = fullText;
            active.onText?.(fullText);
          }
        }
        return;
      }

      if (
        this.#config.showTools !== "none" &&
        (itemType === "commandExecution" ||
          itemType === "fileChange" ||
          itemType === "mcpToolCall" ||
          itemType === "webSearch" ||
          itemType === "dynamicToolCall")
      ) {
        const title = describeCodexTool(item);
        const status = asString(item.status) ?? (method === "item/completed" ? "completed" : "in_progress");
        const prev = active.seenTools.get(itemId);
        if (!prev || prev.status !== status) {
          active.seenTools.set(itemId, { title, status });
          const line =
            method === "item/started"
              ? `\n[${this.label} tool] ${title}...\n`
              : `\n[${this.label} tool ${status}] ${title}\n`;
          if (this.#config.showTools === "text") {
            active.assistantText += line;
            active.onText?.(line);
          } else {
            active.onThinking?.(line);
          }
        }
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params.tokenUsage);
      const total = asRecord(tokenUsage?.total);
      const inputTokens = Number(total?.inputTokens ?? 0) || 0;
      const outputTokens = Number(total?.outputTokens ?? 0) || 0;
      active.inputTokens = inputTokens;
      active.outputTokens = outputTokens;
      active.onUsage?.({ inputTokens, outputTokens });
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const completedTurnId = asString(turn?.id);
      if (active.turnId && completedTurnId && active.turnId !== completedTurnId) return;
      this.#activeTurns.delete(threadId);
      const status = asString(turn?.status) ?? "completed";
      if (status === "failed") {
        const errObj = asRecord(turn?.error);
        const msg = asString(errObj?.message) ?? "Codex turn failed.";
        active.reject(new Error(msg));
        return;
      }
      active.resolve({
        stopReason: "end_turn",
        assistantText: active.assistantText,
        inputTokens: active.inputTokens,
        outputTokens: active.outputTokens,
      });
    }
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = this.#config.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const child = this.#proc;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error("Codex app-server process is not running."));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { child, timer, resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  async warmUp(force = false): Promise<DevinModelEntry[]> {
    if (!force && this.#models.length > 0) return this.#toDevinEntries();
    if (this.#warmupPromise) return this.#warmupPromise;

    this.#warmupPromise = (async () => {
      try {
        await this.#ensureReady();
        const res = await this.#request("model/list", { limit: 100 }, this.#config.startupTimeoutMs);
        const rawList = Array.isArray(res.data) ? res.data : [];
        const parsed: CodexModelRecord[] = [];
        for (const item of rawList) {
          const rec = asRecord(item);
          if (!rec) continue;
          const id = asString(rec.model) ?? asString(rec.id);
          if (!id) continue;
          const displayName = asString(rec.displayName) ?? id;
          const description = asString(rec.description) ?? undefined;
          const modalities = Array.isArray(rec.inputModalities) ? rec.inputModalities.map(String) : ["text", "image"];
          const rawEfforts = Array.isArray(rec.supportedReasoningEfforts) ? rec.supportedReasoningEfforts : [];
          const supportedEfforts: ThoughtLevel[] = [];
          const effortWireValues: Partial<Record<ThoughtLevel, string>> = {};
          for (const e of rawEfforts) {
            const wire = asString(asRecord(e)?.reasoningEffort);
            if (!wire) continue;
            const norm = normalizeEffortValue(wire);
            if (norm) {
              if (!supportedEfforts.includes(norm)) supportedEfforts.push(norm);
              effortWireValues[norm] = wire;
            }
          }
          const rawSpeeds = Array.isArray(rec.additionalSpeedTiers) ? rec.additionalSpeedTiers : [];
          const supportedSpeeds: SpeedMode[] = ["standard"];
          for (const s of rawSpeeds) {
            if (s === "fast" || s === "ultrafast") supportedSpeeds.push(s);
          }
          parsed.push({
            id,
            name: displayName,
            description,
            supportsImages: modalities.includes("image"),
            supportedEfforts,
            effortWireValues,
            defaultEffort: normalizeEffortValue(asString(rec.defaultReasoningEffort)),
            supportedSpeeds,
          });
        }
        if (parsed.length > 0) {
          this.#models = parsed;
        }
        this.#lastError = undefined;
        return this.#toDevinEntries();
      } catch (err) {
        this.#lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    })().finally(() => {
      this.#warmupPromise = null;
    });

    return this.#warmupPromise;
  }

  #toDevinEntries(): DevinModelEntry[] {
    return this.#models.map((m) => ({
      id: m.id,
      name: m.name,
      supportsImages: m.supportsImages,
      ...(m.description ? { description: m.description } : {}),
    }));
  }

  listModels(): BackendModelEntry[] {
    return this.#models.map((m) => ({
      id: m.id,
      name: m.name,
      supportsImages: m.supportsImages,
      description: `ChatGPT: ${m.id}`.slice(0, 100),
      backendKey: this.key,
      backendKind: this.kind,
      backendLabel: this.label,
      nativeId: m.id,
      qualifiedId: `codex.${m.id}`,
    }));
  }

  #findMatchingThread(params: {
    cwd: string;
    systemHash: string;
    fingerprints: readonly string[];
  }): CodexThreadRecord | null {
    const { cwd, systemHash, fingerprints } = params;
    let best: CodexThreadRecord | null = null;
    let bestPrefixLen = 0;

    for (const thread of this.#threads.values()) {
      if (thread.busy || thread.cwd !== cwd || thread.systemHash !== systemHash) continue;
      const len = thread.fingerprints.length;
      if (len === 0 || len >= fingerprints.length || len <= bestPrefixLen) continue;
      let matches = true;
      for (let i = 0; i < len; i += 1) {
        if (thread.fingerprints[i] !== fingerprints[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        best = thread;
        bestPrefixLen = len;
      }
    }
    return best;
  }

  async #evictIfNeeded(): Promise<void> {
    const now = Date.now();
    for (const [id, thread] of this.#threads) {
      if (!thread.busy && now - thread.lastUsedAt > this.#config.idleSessionTtlMs) {
        this.#threads.delete(id);
        await this.#unsubscribeThread(id);
      }
    }
    while (this.#threads.size >= this.#config.maxSessions) {
      let oldest: CodexThreadRecord | null = null;
      for (const thread of this.#threads.values()) {
        if (thread.busy) continue;
        if (!oldest || thread.lastUsedAt < oldest.lastUsedAt) oldest = thread;
      }
      if (!oldest) break;
      this.#threads.delete(oldest.threadId);
      await this.#unsubscribeThread(oldest.threadId);
    }
  }

  async #unsubscribeThread(threadId: string): Promise<void> {
    if (!this.isReady) return;
    try {
      await this.#request("thread/unsubscribe", { threadId }, 5_000);
    } catch {
      // Best-effort cleanup
    }
  }

  async runTurn(
    nativeModelId: string,
    request: AnthropicMessagesRequest,
    callbacks: RunTurnCallbacks,
    hints?: { requestedEffort?: ThoughtLevel | null; requestedSpeed?: SpeedMode | null },
  ): Promise<TurnResult> {
    if (this.#models.length === 0) {
      await this.warmUp();
    } else {
      await this.#ensureReady();
    }

    const cwd = callbacks.cwd ?? this.#config.cwd;
    const { signal, onThinking, onText, onUsage } = callbacks;
    const systemText = extractSystemText(request.system);
    const systemHash = hashSystem(systemText);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const fingerprints = messages.map(messageFingerprint);

    const modelRec = this.#models.find((m) => m.id === nativeModelId) ?? {
      id: nativeModelId,
      name: nativeModelId,
      supportsImages: true,
      supportedEfforts: [] as ThoughtLevel[],
      effortWireValues: {} as Partial<Record<ThoughtLevel, string>>,
      defaultEffort: null,
      supportedSpeeds: [] as SpeedMode[],
    };

    const targetEffort = resolveThoughtLevel(
      {
        requestedEffort: hints?.requestedEffort ?? null,
        outputConfig: request.output_config,
        thinking: request.thinking,
        defaultThoughtLevel: this.#config.thoughtLevel ?? modelRec.defaultEffort,
      },
      modelRec.supportedEfforts,
    );
    const effortWire = targetEffort ? (modelRec.effortWireValues[targetEffort] ?? targetEffort) : undefined;
    const targetSpeed = resolveSpeed(hints?.requestedSpeed ?? null, this.#config.speed, modelRec.supportedSpeeds);

    let thread = this.#findMatchingThread({ cwd, systemHash, fingerprints });
    let isFreshThread = false;

    if (!thread) {
      await this.#evictIfNeeded();
      const { sandbox, approvalPolicy } = mapCodexSandboxAndApproval(this.#config.mode);
      const started = await this.#request(
        "thread/start",
        {
          model: modelRec.id,
          cwd,
          approvalPolicy,
          sandbox,
          ...(systemText ? { developerInstructions: systemText } : {}),
          ephemeral: false,
        },
        this.#config.startupTimeoutMs,
      );
      const threadObj = asRecord(started.thread);
      const threadId = asString(threadObj?.id);
      if (!threadId) throw new Error("Codex thread/start did not return thread.id");
      thread = {
        threadId,
        cwd,
        systemHash,
        fingerprints: [],
        busy: false,
        lastUsedAt: Date.now(),
      };
      this.#threads.set(threadId, thread);
      isFreshThread = true;
    }

    thread.busy = true;
    thread.lastUsedAt = Date.now();

    const deltaMessages = isFreshThread ? messages : messages.slice(thread.fingerprints.length);
    const input = buildCodexUserInput({
      messages: deltaMessages,
      supportsImages: modelRec.supportsImages,
    });

    try {
      const turnDone = new Promise<{
        stopReason: TurnResult["stopReason"];
        assistantText: string;
        inputTokens: number;
        outputTokens: number;
      }>((resolve, reject) => {
        const active: ActiveTurnHandlers = {
          threadId: thread!.threadId,
          turnId: null,
          assistantText: "",
          commentaryItemIds: new Set(),
          seenTools: new Map(),
          inputTokens: 0,
          outputTokens: 0,
          onThinking,
          onText,
          onUsage,
          resolve,
          reject,
        };
        this.#activeTurns.set(thread!.threadId, active);
      });

      const onAbort = () => {
        const active = this.#activeTurns.get(thread!.threadId);
        if (active?.turnId) {
          void this.#request("turn/interrupt", { threadId: thread!.threadId, turnId: active.turnId }, 5_000).catch(
            () => undefined,
          );
        }
        this.#activeTurns.delete(thread!.threadId);
        active?.reject(signal?.reason instanceof Error ? signal.reason : new Error("Codex turn aborted"));
      };

      if (signal?.aborted) {
        this.#activeTurns.delete(thread.threadId);
        throw signal.reason instanceof Error ? signal.reason : new Error("Codex turn aborted");
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#lastActivity = Date.now();
      let overallTimer: ReturnType<typeof setTimeout> | undefined;
      const armOverall = (delay: number) => {
        overallTimer = setTimeout(() => {
          const limit =
            this.#runningTools.size > 0
              ? Math.max(this.#config.requestTimeoutMs, TOOL_IDLE_FLOOR_MS)
              : this.#config.requestTimeoutMs;
          const silent = Date.now() - this.#lastActivity;
          if (silent < limit) {
            armOverall(limit - silent);
            return;
          }
          const active = this.#activeTurns.get(thread!.threadId);
          if (active) {
            this.#activeTurns.delete(thread!.threadId);
            active.reject(new Error(`Codex turn silent for ${this.#config.requestTimeoutMs}ms`));
          }
        }, delay);
      };
      armOverall(this.#config.requestTimeoutMs);

      try {
        const startRes = await this.#request(
          "turn/start",
          {
            threadId: thread.threadId,
            input,
            cwd,
            model: modelRec.id,
            ...(effortWire ? { effort: effortWire } : {}),
            ...(targetSpeed && targetSpeed !== "standard" ? { serviceTierForTurn: targetSpeed } : {}),
            summary: "auto",
          },
          this.#config.startupTimeoutMs,
        );
        const turnObj = asRecord(startRes.turn);
        const active = this.#activeTurns.get(thread.threadId);
        const startedTurnId = asString(turnObj?.id);
        if (active && startedTurnId && !active.turnId) {
          active.turnId = startedTurnId;
        }

        const result = await turnDone;
        const assistantFingerprint = messageFingerprint({ role: "assistant", content: result.assistantText });
        thread.fingerprints = [...fingerprints, assistantFingerprint];
        thread.lastUsedAt = Date.now();
        return {
          modelId: modelRec.id,
          stopReason: result.stopReason,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
          assistantText: result.assistantText,
        };
      } finally {
        clearTimeout(overallTimer);
        signal?.removeEventListener("abort", onAbort);
        this.#activeTurns.delete(thread.threadId);
        this.#runningTools.clear();
      }
    } catch (err) {
      this.#threads.delete(thread.threadId);
      throw err;
    } finally {
      thread.busy = false;
      thread.lastUsedAt = Date.now();
    }
  }

  getStatus(): BackendHealthStatus {
    return {
      key: this.key,
      kind: this.kind,
      label: this.label,
      ready: this.isReady,
      modelsCount: this.#models.length,
      activeSessions: this.activeSessionCount,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#threads.keys()];
    this.#threads.clear();
    await Promise.all(ids.map((id) => this.#unsubscribeThread(id)));
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    await this.closeAll();
    const child = this.#proc;
    this.#proc = null;
    this.#initialized = false;
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
