import { createHash } from "node:crypto";
import { type AcpClient, AcpRpcError } from "./acp-client.js";
import { parseConfigCatalog, resolveDevinModel, resolveThoughtLevel } from "./models.js";
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpSessionUpdate,
  AnthropicContentBlock,
  AnthropicMessageParam,
  AnthropicMessagesRequest,
  ConfigCatalog,
  DevinMode,
  ProxyConfig,
  ThoughtLevel,
  TurnResult,
  TurnUsage,
} from "./types.js";

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
  mode: DevinMode | null;
  thoughtLevel: ThoughtLevel | null;
  busy: boolean;
  lastUsedAt: number;
}

interface SeenToolState {
  title: string;
  status: string;
  announcedStart?: boolean;
}

export interface RunTurnCallbacks {
  cwd?: string;
  signal?: AbortSignal;
  onThinking?: (chunk: string) => void;
  onText?: (chunk: string) => void;
  onUsage?: (usage: TurnUsage) => void;
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

function messageFingerprint(msg: Pick<AnthropicMessageParam, "role" | "content">): string {
  const norm = normalizeMessageContent(msg.content);
  const imgDigest = norm.images.map((img) => `${img.mimeType}:${img.data.length}`).join(",");
  return createHash("sha256")
    .update(`${msg.role}\0${norm.text.trim()}\0${imgDigest}`)
    .digest("hex");
}

function hashSystem(text: string): string {
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

/**
 * Manages ACP session lifecycle, model catalog cache, prefix matching, and turn execution.
 */
export class SessionManager {
  readonly #acp: AcpClient;
  readonly #config: ProxyConfig;
  #catalog: ConfigCatalog = parseConfigCatalog([]);
  readonly #sessions = new Map<string, SessionRecord>();
  #warmupPromise: Promise<ConfigCatalog> | null = null;
  readonly #toolStates = new Map<string, Map<string, SeenToolState>>();

  constructor(acp: AcpClient, config: ProxyConfig) {
    this.#acp = acp;
    this.#config = config;
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
      const created = await this.#acp.newSession({ cwd: this.#config.cwd });
      this.#updateCatalog(created.configOptions);
      if (created.sessionId) {
        await this.#acp.closeSession(created.sessionId);
      }
      return this.#catalog;
    })().finally(() => {
      this.#warmupPromise = null;
    });

    return this.#warmupPromise;
  }

  #updateCatalog(configOptions: readonly AcpConfigOption[] | undefined): void {
    const parsed = parseConfigCatalog(configOptions);
    if (parsed.models.length > 0) {
      this.#catalog = parsed;
    }
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
    this.#updateCatalog(created.configOptions);
    const localCatalog = parseConfigCatalog(created.configOptions);
    const record: SessionRecord = {
      id: created.sessionId,
      cwd,
      systemHash: "",
      fingerprints: [],
      model: localCatalog.currentModel,
      mode: localCatalog.currentMode,
      thoughtLevel: localCatalog.currentThoughtLevel,
      busy: false,
      lastUsedAt: Date.now(),
    };
    this.#sessions.set(record.id, record);
    return record;
  }

  async #configureSession(
    session: SessionRecord,
    settings: { targetModel: string; mode: DevinMode; thoughtLevel: ThoughtLevel | null },
  ): Promise<void> {
    if (settings.mode && session.mode !== settings.mode) {
      const updated = await this.#acp.setConfigOption(session.id, "mode", settings.mode);
      this.#updateCatalog(updated.configOptions);
      session.mode = settings.mode;
    }
    if (settings.targetModel && session.model !== settings.targetModel) {
      const updated = await this.#acp.setConfigOption(session.id, "model", settings.targetModel);
      this.#updateCatalog(updated.configOptions);
      session.model = settings.targetModel;
    }
    if (settings.thoughtLevel && session.thoughtLevel !== settings.thoughtLevel) {
      const updated = await this.#acp.setConfigOption(session.id, "thought_level", settings.thoughtLevel);
      this.#updateCatalog(updated.configOptions);
      session.thoughtLevel = settings.thoughtLevel;
    }
  }

  /**
   * Execute an Anthropic /v1/messages turn through an ACP session and forward streaming events.
   */
  async runTurn(request: AnthropicMessagesRequest, callbacks: RunTurnCallbacks): Promise<TurnResult> {
    if (this.#catalog.models.length === 0) {
      await this.warmUp();
    }

    const cwd = callbacks.cwd ?? this.#config.cwd;
    const { signal, onThinking, onText, onUsage } = callbacks;
    const systemText = extractSystemText(request.system);
    const systemHash = hashSystem(systemText);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const fingerprints = messages.map(messageFingerprint);

    const resolvedModel = resolveDevinModel(request.model, this.#catalog.models, {
      defaultModel: this.#config.defaultModel,
      modelMap: this.#config.modelMap,
    });
    const thoughtLevel = resolveThoughtLevel(
      request.thinking,
      this.#config.thoughtLevel,
      this.#catalog.thoughtLevels,
    );

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
        supportsImages: resolvedModel.supportsImages,
      });

      let assistantText = "";
      let deliveredAnyChunk = false;

      const onUpdate = ({ sessionId, update }: { sessionId: string; update: AcpSessionUpdate }) => {
        if (!session || sessionId !== session.id) return;
        const kind = update.sessionUpdate;

        if (kind === "config_option_update") {
          this.#updateCatalog(update.configOptions);
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
        await this.#configureSession(session, {
          targetModel: resolvedModel.id,
          mode: this.#config.mode,
          thoughtLevel,
        });

        const promptResult = await this.#acp.prompt(session.id, promptBlocks, { signal });
        const assistantFingerprint = messageFingerprint({ role: "assistant", content: assistantText });
        session.fingerprints = [...fingerprints, assistantFingerprint];
        session.lastUsedAt = Date.now();

        return {
          modelId: resolvedModel.id,
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

    throw new Error("Failed to establish Devin ACP session.");
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
      return `\n[Devin tool] ${title}...\n`;
    }
    if (status === "completed" || status === "failed") {
      return `\n[Devin tool ${status}] ${title}\n`;
    }
    return "";
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#sessions.keys()];
    this.#sessions.clear();
    await Promise.all(ids.map((id) => this.#acp.closeSession(id)));
  }
}

function mapStopReason(acpStopReason: string | undefined): TurnResult["stopReason"] {
  if (acpStopReason === "max_tokens" || acpStopReason === "max_turn_requests") return "max_tokens";
  if (acpStopReason === "refusal") return "refusal";
  return "end_turn";
}
