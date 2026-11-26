import { createHash } from "node:crypto";
import { AcpRpcError } from "./acp-client.mjs";
import { parseConfigCatalog, resolveDevinModel, resolveThoughtLevel } from "./models.mjs";

export function extractSystemText(system) {
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

export function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }

  const textParts = [];
  const images = [];
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
      const inputJson = safeJson(block.input);
      textParts.push(`[Tool Call: ${block.name ?? "tool"}]\n${inputJson}`);
    } else if (block.type === "tool_result") {
      const nested = normalizeMessageContent(block.content);
      const prefix = block.is_error ? "[Tool Error]" : "[Tool Result]";
      textParts.push(`${prefix}\n${nested.text}`);
      images.push(...nested.images);
    }
  }
  return { text: textParts.join("\n\n").trim(), images };
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function messageFingerprint(msg) {
  const norm = normalizeMessageContent(msg?.content);
  const imgDigest = norm.images.map((img) => `${img.mimeType}:${img.data.length}`).join(",");
  return createHash("sha256")
    .update(`${msg?.role ?? "user"}\0${norm.text.trim()}\0${imgDigest}`)
    .digest("hex");
}

function hashSystem(text) {
  return createHash("sha256").update(text).digest("hex");
}

function buildPromptBlocks({ systemText, messages, includeSystem, supportsImages }) {
  const blocks = [];
  const chunks = [];

  if (includeSystem && systemText) {
    chunks.push(`<system_instructions>\n${systemText}\n</system_instructions>`);
  }

  if (messages.length === 1 && messages[0].role === "user") {
    const norm = normalizeMessageContent(messages[0].content);
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

function appendImages(blocks, images, supportsImages) {
  if (images.length === 0) return;
  if (!supportsImages) {
    blocks.push({ type: "text", text: `[${images.length} image attachment(s) omitted because selected model does not support images]` });
    return;
  }
  for (const image of images) {
    blocks.push(image);
  }
}

/**
 * Manages ACP session lifecycle, model catalog cache, prefix matching, and turn execution.
 */
export class SessionManager {
  #acp;
  #config;
  #catalog = parseConfigCatalog([]);
  #sessions = new Map();
  #warmupPromise = null;
  #toolStates = new Map();

  constructor(acp, config) {
    this.#acp = acp;
    this.#config = config;
    this.#acp.on("exit", () => {
      this.#sessions.clear();
    });
  }

  get catalog() {
    return this.#catalog;
  }

  get activeSessionCount() {
    return this.#sessions.size;
  }

  async warmUp() {
    if (this.#catalog.models.length > 0) return this.#catalog;
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

  #updateCatalog(configOptions) {
    const parsed = parseConfigCatalog(configOptions);
    if (parsed.models.length > 0) {
      this.#catalog = parsed;
    }
  }

  #findMatchingSession({ cwd, systemHash, fingerprints }) {
    let best = null;
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

  async #evictIfNeeded() {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (!session.busy && now - session.lastUsedAt > this.#config.idleSessionTtlMs) {
        this.#sessions.delete(id);
        await this.#acp.closeSession(id);
      }
    }

    while (this.#sessions.size >= this.#config.maxSessions) {
      let oldest = null;
      for (const session of this.#sessions.values()) {
        if (session.busy) continue;
        if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
      }
      if (!oldest) break;
      this.#sessions.delete(oldest.id);
      await this.#acp.closeSession(oldest.id);
    }
  }

  async #createSession(cwd) {
    await this.#evictIfNeeded();
    const created = await this.#acp.newSession({ cwd });
    this.#updateCatalog(created.configOptions);
    const localCatalog = parseConfigCatalog(created.configOptions);
    const record = {
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

  async #configureSession(session, { targetModel, mode, thoughtLevel }) {
    if (mode && session.mode !== mode) {
      const updated = await this.#acp.setConfigOption(session.id, "mode", mode);
      this.#updateCatalog(updated.configOptions);
      session.mode = mode;
    }
    if (targetModel && session.model !== targetModel) {
      const updated = await this.#acp.setConfigOption(session.id, "model", targetModel);
      this.#updateCatalog(updated.configOptions);
      session.model = targetModel;
    }
    if (thoughtLevel && session.thoughtLevel !== thoughtLevel) {
      const updated = await this.#acp.setConfigOption(session.id, "thought_level", thoughtLevel);
      this.#updateCatalog(updated.configOptions);
      session.thoughtLevel = thoughtLevel;
    }
  }

  /**
   * Execute an Anthropic /v1/messages turn through an ACP session and forward streaming events.
   */
  async runTurn(request, { cwd = this.#config.cwd, signal, onThinking, onText, onUsage }) {
    if (this.#catalog.models.length === 0) {
      await this.warmUp();
    }

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

      const onUpdate = ({ sessionId, update }) => {
        if (sessionId !== session.id || !update) return;
        const kind = update.sessionUpdate;

        if (kind === "config_option_update") {
          this.#updateCatalog(update.configOptions);
          return;
        }
        if (kind === "usage_update") {
          onUsage?.({
            inputTokens: update._meta?.["cognition.ai/inputTokens"] ?? update.used ?? 0,
            outputTokens: update._meta?.["cognition.ai/outputTokens"] ?? 0,
          });
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
        void this.#acp.cancel(session.id);
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
          stopReason: mapStopReason(promptResult?.stopReason),
          usage: {
            inputTokens: promptResult?.usage?.inputTokens ?? 0,
            outputTokens: promptResult?.usage?.outputTokens ?? 0,
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
        this.#toolStates.delete(session?.id);
        if (session) {
          session.busy = false;
          session.lastUsedAt = Date.now();
        }
      }
    }

    throw new Error("Failed to establish Devin ACP session.");
  }

  #formatToolUpdate(sessionId, update) {
    if (update._meta?.["cognition.ai/eventType"] === "hook_execution" && update.status !== "failed") {
      return "";
    }
    let seen = this.#toolStates.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.#toolStates.set(sessionId, seen);
    }

    const id = update.toolCallId || update.title || update.name || "tool";
    const prev = seen.get(id) ?? {};
    const title = update.title || update.name || prev.title || "tool";
    const status = update.status || prev.status || "running";

    if (prev.title === title && prev.status === status) return "";
    seen.set(id, { title, status });

    if (status === "pending" || status === "in_progress") {
      if (prev.announcedStart) return "";
      seen.set(id, { title, status, announcedStart: true });
      return `\n[Devin tool] ${title}...\n`;
    }
    if (status === "completed" || status === "failed") {
      return `\n[Devin tool ${status}] ${title}\n`;
    }
    return "";
  }

  async closeAll() {
    const ids = [...this.#sessions.keys()];
    this.#sessions.clear();
    await Promise.all(ids.map((id) => this.#acp.closeSession(id)));
  }
}

function mapStopReason(acpStopReason) {
  if (acpStopReason === "max_tokens" || acpStopReason === "max_turn_requests") return "max_tokens";
  if (acpStopReason === "refusal") return "refusal";
  return "end_turn";
}
