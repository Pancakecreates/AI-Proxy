import { createHash } from "node:crypto";
import { type AcpClient, AcpRpcError } from "./acp-client.js";
import { parseConfigCatalog, resolveDevinModelWithHints, resolveSpeed, resolveThoughtLevel } from "./models.js";
import type {
  AcpAvailableModelFallback,
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionUpdate,
  AnthropicContentBlock,
  AnthropicMessageParam,
  AnthropicMessagesRequest,
  BackendHealthStatus,
  BackendKind,
  BackendModelEntry,
  ConfigCatalog,
  DevinMode,
  DevinModelEntry,
  ProxyBackend,
  ProxyConfig,
  RunTurnCallbacks,
  SpeedMode,
  ThoughtConfigId,
  ThoughtLevel,
  TurnResult,
} from "./types.js";

export type { RunTurnCallbacks };

interface NormalizedContent {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}

interface SessionRecord {
  id: string;
  cwd: string;
  systemHash: string;
  fingerprints: string[];
  model: string | null;
  mode: string | null;
  thoughtLevel: ThoughtLevel | null;
  thoughtConfigId: ThoughtConfigId | null;
  thoughtWireValues: Partial<Record<ThoughtLevel, string>>;
  speed: SpeedMode | null;
  supportedModes: string[];
  supportedThoughtLevels: ThoughtLevel[];
  supportedSpeeds: SpeedMode[];
  busy: boolean;
  lastUsedAt: number;
}

interface SeenToolState {
  title: string;
  status: string;
  announcedStart?: boolean;
}

export interface SessionManagerOptions {
  backendKind?: BackendKind;
  backendLabel?: string;
  filterModels?: (models: readonly DevinModelEntry[]) => DevinModelEntry[];
}

export function extractSystemText(system: AnthropicMessagesRequest["system"]): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function normalizeMessageContent(content: string | AnthropicContentBlock[] | undefined): NormalizedContent {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }

  const textParts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
      images.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type || "image/png",
      });
    } else if (block.type === "tool_use") {
      textParts.push(`[Tool Call: ${block.name ?? "tool"}]\n${safeJson(block.input)}`);
    } else if (block.type === "tool_result") {
      const nested = normalizeMessageContent(block.content);
      const prefix = block.is_error ? "[Tool Error]" : "[Tool Result]";
      textParts.push(`${prefix}\n${nested.text}`);
      images.push(...nested.images);
    }
  }
  return { text: textParts.join("\n\n").trim(), images };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function messageFingerprint(msg: Pick<AnthropicMessageParam, "role" | "content">): string {
  const norm = normalizeMessageContent(msg.content);
  const imgDigest = norm.images.map((img) => `${img.mimeType}:${img.data.length}`).join(",");
  return createHash("sha256")
    .update(`${msg.role}\0${norm.text.trim()}\0${imgDigest}`)
    .digest("hex");
}

export function hashSystem(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appendImages(
  blocks: AcpContentBlock[],
  images: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>,
  supportsImages: boolean,
): void {
  if (images.length === 0) return;
  if (!supportsImages) {
    blocks.push({
      type: "text",
      text: `[${images.length} image attachment(s) omitted because selected model does not support images]`,
    });
    return;
  }
  for (const image of images) {
    blocks.push(image);
  }
}

function buildPromptBlocks(params: {
  systemText: string;
  messages: readonly AnthropicMessageParam[];
  includeSystem: boolean;
  supportsImages: boolean;
}): AcpContentBlock[] {
  const { systemText, messages, includeSystem, supportsImages } = params;
  const blocks: AcpContentBlock[] = [];
  const chunks: string[] = [];

  if (includeSystem && systemText) {
    chunks.push(`<system_instructions>\n${systemText}\n</system_instructions>`);
  }

  const single = messages.length === 1 ? messages[0] : undefined;
  if (single && single.role === "user") {
    const norm = normalizeMessageContent(single.content);
    if (norm.text) chunks.push(norm.text);
    if (chunks.length > 0) blocks.push({ type: "text", text: chunks.join("\n\n") });
    appendImages(blocks, norm.images, supportsImages);
  } else {
    for (const msg of messages) {
      const norm = normalizeMessageContent(msg.content);
      const label = msg.role === "assistant" ? "Assistant" : "User";
      if (norm.text) chunks.push(`[${label}]\n${norm.text}`);
      appendImages(blocks, norm.images, supportsImages);
    }
    if (chunks.length > 0) blocks.unshift({ type: "text", text: chunks.join("\n\n") });
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "Continue." });
  }
  return blocks;
}

function mapModeForBackend(
  backendKind: BackendKind,
  requested: DevinMode,
  supportedModes: readonly string[],
): string | null {
  if (supportedModes.length === 0) return null;
  if (supportedModes.includes(requested)) return requested;

  if (backendKind === "antigravity") {
    const mapped =
      requested === "bypass" || requested === "smart"
        ? "auto"
        : requested === "ask"
          ? "default"
          : requested;
    if (supportedModes.includes(mapped)) return mapped;
  } else if (backendKind === "opencode") {
    const mapped = requested === "plan" ? "plan" : "build";
    if (supportedModes.includes(mapped)) return mapped;
  }

  return null;
}

/**
 * Manages ACP session lifecycle, model catalog cache, prefix matching, and turn execution.
 */
export class SessionManager {
  readonly #acp: AcpClient;
  readonly #config: ProxyConfig;
  readonly #backendKind: BackendKind;
  readonly #backendLabel: string;
  readonly #filterModels: ((models: readonly DevinModelEntry[]) => DevinModelEntry[]) | undefined;
  #catalog: ConfigCatalog = parseConfigCatalog([]);
  readonly #sessions = new Map<string, SessionRecord>();
  #warmupPromise: Promise<ConfigCatalog> | null = null;
  readonly #toolStates = new Map<string, Map<string, SeenToolState>>();

  constructor(acp: AcpClient, config: ProxyConfig, options: SessionManagerOptions = {}) {
    this.#acp = acp;
    this.#config = config;
    this.#backendKind = options.backendKind ?? "devin";
    this.#backendLabel = options.backendLabel ?? acp.label;
    this.#filterModels = options.filterModels;
    this.#acp.on("exit", () => {
      this.#sessions.clear();
    });
  }

  get catalog(): ConfigCatalog {
    return this.#catalog;
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  async warmUp(force = false): Promise<ConfigCatalog> {
    if (!force && this.#catalog.models.length > 0) return this.#catalog;
    if (this.#warmupPromise) return this.#warmupPromise;

    this.#warmupPromise = (async () => {
      let created = await this.#acp.newSession({ cwd: this.#config.cwd });
      this.#updateCatalog(created.configOptions, created.models?.availableModels);
      if (created.sessionId) {
        await this.#acp.closeSession(created.sessionId);
      }

      // OpenCode can return only partial/built-in models on very first cold session/new
      // while background provider catalogs (like opencode-go) finish loading.
      if (
        this.#backendKind === "opencode" &&
        !this.#catalog.models.some((m) => m.id.toLowerCase().startsWith("opencode-go/"))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        created = await this.#acp.newSession({ cwd: this.#config.cwd });
        this.#updateCatalog(created.configOptions, created.models?.availableModels);
        if (created.sessionId) {
          await this.#acp.closeSession(created.sessionId);
        }
      }

      return this.#catalog;
    })().finally(() => {
      this.#warmupPromise = null;
    });

    return this.#warmupPromise;
  }

  #updateCatalog(
    configOptions: readonly AcpConfigOption[] | undefined,
    fallbackModels?: readonly AcpAvailableModelFallback[],
  ): void {
    const parsed = parseConfigCatalog(configOptions, fallbackModels);
    if (parsed.models.length > 0) {
      if (this.#filterModels) {
        parsed.models = this.#filterModels(parsed.models);
      }
      this.#catalog = parsed;
    }
  }

  #applySessionConfigSnapshot(
    session: SessionRecord,
    configOptions: readonly AcpConfigOption[] | undefined,
    fallbackModels?: readonly AcpAvailableModelFallback[],
  ): void {
    if (!Array.isArray(configOptions) || configOptions.length === 0) return;
    this.#updateCatalog(configOptions, fallbackModels);
    const parsed = parseConfigCatalog(configOptions, fallbackModels);
    if (parsed.currentMode) session.mode = parsed.currentMode;
    if (parsed.modes.length > 0) session.supportedModes = parsed.modes;
    if (parsed.currentModel) session.model = parsed.currentModel;
    if (parsed.thoughtConfigId) session.thoughtConfigId = parsed.thoughtConfigId;
    if (Object.keys(parsed.thoughtWireValues).length > 0) {
      session.thoughtWireValues = { ...session.thoughtWireValues, ...parsed.thoughtWireValues };
    }
    if (parsed.currentThoughtLevel) session.thoughtLevel = parsed.currentThoughtLevel;
    if (parsed.currentSpeed) session.speed = parsed.currentSpeed;
    if (parsed.thoughtLevels.length > 0) session.supportedThoughtLevels = parsed.thoughtLevels;
    if (parsed.speeds.length > 0) session.supportedSpeeds = parsed.speeds;
  }

  #findMatchingSession(params: {
    cwd: string;
    systemHash: string;
    fingerprints: readonly string[];
  }): SessionRecord | null {
    const { cwd, systemHash, fingerprints } = params;
    let best: SessionRecord | null = null;
    let bestPrefixLen = 0;

    for (const session of this.#sessions.values()) {
      if (session.busy || session.cwd !== cwd || session.systemHash !== systemHash) continue;
      const len = session.fingerprints.length;
      if (len === 0 || len >= fingerprints.length || len <= bestPrefixLen) continue;

      let matches = true;
      for (let i = 0; i < len; i += 1) {
        if (session.fingerprints[i] !== fingerprints[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        best = session;
        bestPrefixLen = len;
      }
    }
    return best;
  }

  async #evictIfNeeded(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (!session.busy && now - session.lastUsedAt > this.#config.idleSessionTtlMs) {
        this.#sessions.delete(id);
        await this.#acp.closeSession(id);
      }
    }

    while (this.#sessions.size >= this.#config.maxSessions) {
      let oldest: SessionRecord | null = null;
      for (const session of this.#sessions.values()) {
        if (session.busy) continue;
        if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
      }
      if (!oldest) break;
      this.#sessions.delete(oldest.id);
      await this.#acp.closeSession(oldest.id);
    }
  }

  async #createSession(cwd: string): Promise<SessionRecord> {
    await this.#evictIfNeeded();
    const created = await this.#acp.newSession({ cwd });
    this.#updateCatalog(created.configOptions, created.models?.availableModels);
    const localCatalog = parseConfigCatalog(created.configOptions, created.models?.availableModels);
    const record: SessionRecord = {
      id: created.sessionId,
      cwd,
      systemHash: "",
      fingerprints: [],
      model: localCatalog.currentModel ?? created.models?.currentModelId ?? null,
      mode: localCatalog.currentMode,
      thoughtLevel: localCatalog.currentThoughtLevel,
      thoughtConfigId: localCatalog.thoughtConfigId,
      thoughtWireValues: localCatalog.thoughtWireValues,
      speed: localCatalog.currentSpeed,
      supportedModes: localCatalog.modes,
      supportedThoughtLevels: localCatalog.thoughtLevels,
      supportedSpeeds: localCatalog.speeds,
      busy: false,
      lastUsedAt: Date.now(),
    };
    this.#sessions.set(record.id, record);
    return record;
  }

  async #configureSession(
    session: SessionRecord,
    request: AnthropicMessagesRequest,
    selection: { targetModel: string; requestedEffort: ThoughtLevel | null; requestedSpeed: SpeedMode | null },
  ): Promise<void> {
    const supportedModes = session.supportedModes.length > 0 ? session.supportedModes : this.#catalog.modes;
    const targetMode = mapModeForBackend(this.#backendKind, this.#config.mode, supportedModes);
    if (targetMode && session.mode !== targetMode) {
      const updated = await this.#acp.setConfigOption(session.id, "mode", targetMode);
      this.#applySessionConfigSnapshot(session, updated.configOptions);
      session.mode = targetMode;
    }

    if (selection.targetModel && session.model !== selection.targetModel) {
      const updated = await this.#acp.setConfigOption(session.id, "model", selection.targetModel);
      this.#applySessionConfigSnapshot(session, updated.configOptions);
      session.model = selection.targetModel;
    }

    const thoughtConfigId = session.thoughtConfigId ?? this.#catalog.thoughtConfigId;
    const supportedEfforts =
      session.supportedThoughtLevels.length > 0 ? session.supportedThoughtLevels : this.#catalog.thoughtLevels;
    const targetEffort = resolveThoughtLevel(
      {
        requestedEffort: selection.requestedEffort,
        outputConfig: request.output_config,
        thinking: request.thinking,
        defaultThoughtLevel: this.#config.thoughtLevel,
      },
      supportedEfforts,
    );
    if (thoughtConfigId && targetEffort && session.thoughtLevel !== targetEffort) {
      const wireValue =
        session.thoughtWireValues[targetEffort] ?? this.#catalog.thoughtWireValues[targetEffort] ?? targetEffort;
      const updated = await this.#acp.setConfigOption(session.id, thoughtConfigId, wireValue);
      this.#applySessionConfigSnapshot(session, updated.configOptions);
      session.thoughtLevel = targetEffort;
    }

    const targetSpeed = resolveSpeed(selection.requestedSpeed, this.#config.speed, session.supportedSpeeds);
    if (targetSpeed && session.speed !== targetSpeed) {
      const updated = await this.#acp.setConfigOption(session.id, "speed", targetSpeed);
      this.#applySessionConfigSnapshot(session, updated.configOptions);
      session.speed = targetSpeed;
    }
  }

  /**
   * Execute an Anthropic /v1/messages turn through an ACP session and forward streaming events.
   */
  async runTurn(
    request: AnthropicMessagesRequest,
    callbacks: RunTurnCallbacks,
    explicitSelection?: { model: DevinModelEntry; requestedEffort: ThoughtLevel | null; requestedSpeed: SpeedMode | null },
  ): Promise<TurnResult> {
    if (this.#catalog.models.length === 0) {
      await this.warmUp();
    }

    const cwd = callbacks.cwd ?? this.#config.cwd;
    const { signal, onThinking, onText, onUsage } = callbacks;
    const systemText = extractSystemText(request.system);
    const systemHash = hashSystem(systemText);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const fingerprints = messages.map(messageFingerprint);

    const selection =
      explicitSelection ??
      resolveDevinModelWithHints(request.model, this.#catalog.models, {
        defaultModel: this.#config.defaultModel,
        modelMap: this.#config.modelMap,
      });

    let session = this.#findMatchingSession({ cwd, systemHash, fingerprints });
    let isFreshSession = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!session) {
        session = await this.#createSession(cwd);
        session.systemHash = systemHash;
        isFreshSession = true;
      }

      session.busy = true;
      session.lastUsedAt = Date.now();
      this.#toolStates.delete(session.id);

      const deltaMessages = isFreshSession ? messages : messages.slice(session.fingerprints.length);
      const promptBlocks = buildPromptBlocks({
        systemText,
        messages: deltaMessages,
        includeSystem: isFreshSession,
        supportsImages: selection.model.supportsImages,
      });

      let assistantText = "";
      let deliveredAnyChunk = false;

      const onUpdate = ({ sessionId, update }: { sessionId: string; update: AcpSessionUpdate }) => {
        if (!session || sessionId !== session.id) return;
        const kind = update.sessionUpdate;

        if (kind === "config_option_update") {
          this.#applySessionConfigSnapshot(session, update.configOptions);
          return;
        }
        if (kind === "usage_update") {
          const inputTokens = Number(update._meta?.["cognition.ai/inputTokens"] ?? update.used ?? 0) || 0;
          const outputTokens = Number(update._meta?.["cognition.ai/outputTokens"] ?? 0) || 0;
          onUsage?.({ inputTokens, outputTokens });
          return;
        }
        if (kind === "agent_thought_chunk" && update.content?.type === "text" && update.content.text) {
          deliveredAnyChunk = true;
          onThinking?.(update.content.text);
          return;
        }
        if (kind === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
          deliveredAnyChunk = true;
          assistantText += update.content.text;
          onText?.(update.content.text);
          return;
        }
        if ((kind === "tool_call" || kind === "tool_call_update") && this.#config.showTools !== "none") {
          const line = this.#formatToolUpdate(session.id, update);
          if (line) {
            deliveredAnyChunk = true;
            if (this.#config.showTools === "text") {
              assistantText += line;
              onText?.(line);
            } else {
              onThinking?.(line);
            }
          }
        }
      };

      const onAbort = () => {
        if (session) void this.#acp.cancel(session.id);
      };

      this.#acp.on("sessionUpdate", onUpdate);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await this.#configureSession(session, request, {
          targetModel: selection.model.id,
          requestedEffort: selection.requestedEffort,
          requestedSpeed: selection.requestedSpeed,
        });

        const promptResult = await this.#acp.prompt(session.id, promptBlocks, { signal });
        const assistantFingerprint = messageFingerprint({ role: "assistant", content: assistantText });
        session.fingerprints = [...fingerprints, assistantFingerprint];
        session.lastUsedAt = Date.now();

        return {
          modelId: selection.model.id,
          stopReason: mapStopReason(promptResult.stopReason),
          usage: {
            inputTokens: promptResult.usage?.inputTokens ?? 0,
            outputTokens: promptResult.usage?.outputTokens ?? 0,
          },
          assistantText,
        };
      } catch (err) {
        this.#sessions.delete(session.id);
        const canRetry =
          attempt === 0 &&
          !deliveredAnyChunk &&
          !signal?.aborted &&
          ((err instanceof AcpRpcError && err.isSessionNotFound) || !this.#acp.isReady);
        if (canRetry) {
          session = null;
          isFreshSession = false;
          continue;
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.#acp.off("sessionUpdate", onUpdate);
        if (session) {
          this.#toolStates.delete(session.id);
          session.busy = false;
          session.lastUsedAt = Date.now();
        }
      }
    }

    throw new Error(`Failed to establish ${this.#backendLabel} ACP session.`);
  }

  #formatToolUpdate(sessionId: string, update: AcpSessionUpdate): string {
    if (update._meta?.["cognition.ai/eventType"] === "hook_execution" && update.status !== "failed") {
      return "";
    }
    let seen = this.#toolStates.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.#toolStates.set(sessionId, seen);
    }

    const id = update.toolCallId || update.title || update.name || "tool";
    const prev = seen.get(id);
    const title = update.title || update.name || prev?.title || "tool";
    const status = update.status || prev?.status || "running";

    if (prev && prev.title === title && prev.status === status) return "";
    seen.set(id, { title, status, announcedStart: prev?.announcedStart });

    if (status === "pending" || status === "in_progress") {
      if (prev?.announcedStart) return "";
      seen.set(id, { title, status, announcedStart: true });
      return `\n[${this.#backendLabel} tool] ${title}...\n`;
    }
    if (status === "completed" || status === "failed") {
      return `\n[${this.#backendLabel} tool ${status}] ${title}\n`;
    }
    return "";
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#sessions.keys()];
    this.#sessions.clear();
    await Promise.all(ids.map((id) => this.#acp.closeSession(id)));
  }
}

export interface AcpProxyBackendOptions {
  key: string;
  kind: BackendKind;
  label: string;
  acp: AcpClient;
  sessions: SessionManager;
  qualifiedPrefix: string;
  formatQualifiedId?: (model: DevinModelEntry) => string;
  formatDisplayName?: (model: DevinModelEntry) => string;
  formatDescription?: (model: DevinModelEntry) => string;
}

/**
 * ProxyBackend adapter wrapping an ACP client + SessionManager.
 */
export class AcpProxyBackend implements ProxyBackend {
  readonly key: string;
  readonly kind: BackendKind;
  readonly label: string;
  readonly #acp: AcpClient;
  readonly #sessions: SessionManager;
  readonly #qualifiedPrefix: string;
  readonly #formatQualifiedId: ((model: DevinModelEntry) => string) | undefined;
  readonly #formatDisplayName: ((model: DevinModelEntry) => string) | undefined;
  readonly #formatDescription: ((model: DevinModelEntry) => string) | undefined;
  #lastError: string | undefined;

  constructor(options: AcpProxyBackendOptions) {
    this.key = options.key;
    this.kind = options.kind;
    this.label = options.label;
    this.#acp = options.acp;
    this.#sessions = options.sessions;
    this.#qualifiedPrefix = options.qualifiedPrefix;
    this.#formatQualifiedId = options.formatQualifiedId;
    this.#formatDisplayName = options.formatDisplayName;
    this.#formatDescription = options.formatDescription;
  }

  get isReady(): boolean {
    return this.#acp.isReady;
  }

  get activeSessionCount(): number {
    return this.#sessions.activeSessionCount;
  }

  async warmUp(force = false): Promise<DevinModelEntry[]> {
    try {
      const catalog = await this.#sessions.warmUp(force);
      this.#lastError = undefined;
      return catalog.models;
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  listModels(): BackendModelEntry[] {
    return this.#sessions.catalog.models.map((m) => ({
      ...m,
      name: this.#formatDisplayName ? this.#formatDisplayName(m) : m.name,
      ...(this.#formatDescription ? { description: this.#formatDescription(m) } : {}),
      backendKey: this.key,
      backendKind: this.kind,
      backendLabel: this.label,
      nativeId: m.id,
      qualifiedId: this.#formatQualifiedId
        ? this.#formatQualifiedId(m)
        : this.#qualifiedPrefix
          ? `${this.#qualifiedPrefix}${m.id}`
          : m.id,
    }));
  }

  async runTurn(
    nativeModelId: string,
    request: AnthropicMessagesRequest,
    callbacks: RunTurnCallbacks,
    hints?: { requestedEffort?: ThoughtLevel | null; requestedSpeed?: SpeedMode | null },
  ): Promise<TurnResult> {
    const model =
      this.#sessions.catalog.models.find((m) => m.id === nativeModelId) ?? {
        id: nativeModelId,
        name: nativeModelId,
        supportsImages: true,
      };
    return this.#sessions.runTurn(request, callbacks, {
      model,
      requestedEffort: hints?.requestedEffort ?? null,
      requestedSpeed: hints?.requestedSpeed ?? null,
    });
  }

  getStatus(): BackendHealthStatus {
    return {
      key: this.key,
      kind: this.kind,
      label: this.label,
      ready: this.isReady,
      modelsCount: this.#sessions.catalog.models.length,
      activeSessions: this.activeSessionCount,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  async closeAll(): Promise<void> {
    await this.#sessions.closeAll();
  }

  async shutdown(): Promise<void> {
    await this.#sessions.closeAll();
    await this.#acp.shutdown();
  }
}

function mapStopReason(acpStopReason: string | undefined): TurnResult["stopReason"] {
  if (acpStopReason === "max_tokens" || acpStopReason === "max_turn_requests") return "max_tokens";
  if (acpStopReason === "refusal") return "refusal";
  return "end_turn";
}
