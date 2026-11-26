import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AcpRpcError } from "./acp-client.js";
import { extractSystemText, normalizeMessageContent, type SessionManager } from "./sessions.js";
import type { AnthropicMessagesRequest, TurnUsage } from "./types.js";

const KEEPALIVE_INTERVAL_MS = 15_000;

export function createMessageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

export function estimateInputTokens(body: Partial<AnthropicMessagesRequest> | undefined): number {
  let chars = extractSystemText(body?.system).length;
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      const norm = normalizeMessageContent(msg?.content);
      chars += norm.text.length + norm.images.length * 800;
    }
  }
  if (Array.isArray(body?.tools)) {
    try {
      chars += JSON.stringify(body.tools).length;
    } catch {
      // Ignore unserializable tool payload
    }
  }
  return Math.max(1, Math.ceil(chars / 3.5));
}

export function sendAnthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify({
    type: "error",
    error: { type, message },
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorStatusAndType(err: unknown): { status: number; type: string; message: string } {
  const isAuth = err instanceof AcpRpcError && err.isAuthError;
  const message = err instanceof Error ? err.message : "Devin ACP execution failed.";
  return {
    status: isAuth ? 401 : 502,
    type: isAuth ? "authentication_error" : "api_error",
    message,
  };
}

/**
 * Handle POST /v1/messages (both streaming SSE and non-streaming JSON).
 */
export async function handleMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: AnthropicMessagesRequest,
  context: { sessions: SessionManager; cwd: string; allowThinking?: boolean },
): Promise<void> {
  const { sessions, cwd, allowThinking = true } = context;

  if (!body || typeof body !== "object" || !Array.isArray(body.messages) || body.messages.length === 0) {
    sendAnthropicError(res, 400, "invalid_request_error", "Field 'messages' must be a non-empty array.");
    return;
  }

  const messageId = createMessageId();
  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "swe-2-1-medium";
  const isStream = body.stream === true;
  const thinkingEnabled = allowThinking && body.thinking?.type !== "disabled";

  const controller = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  if (!isStream) {
    try {
      let thinking = "";
      let text = "";
      let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

      const result = await sessions.runTurn(body, {
        cwd,
        signal: controller.signal,
        onThinking: (chunk) => {
          if (thinkingEnabled) thinking += chunk;
        },
        onText: (chunk) => {
          text += chunk;
        },
        onUsage: (usage) => {
          latestUsage = usage;
        },
      });

      const content: Array<
        { type: "thinking"; thinking: string; signature: string } | { type: "text"; text: string }
      > = [];
      if (thinkingEnabled && thinking) {
        content.push({ type: "thinking", thinking, signature: "devin-acp" });
      }
      if (text) {
        content.push({ type: "text", text });
      } else if (content.length === 0) {
        content.push({ type: "text", text: "Done." });
      }

      const inputTokens = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(body);
      const outputTokens =
        result.usage.outputTokens ||
        latestUsage.outputTokens ||
        Math.max(1, Math.ceil((text.length + thinking.length) / 3.5));

      const payload = JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model: result.modelId || requestedModel,
        content,
        stop_reason: result.stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    } catch (err) {
      if (controller.signal.aborted) return;
      const mapped = errorStatusAndType(err);
      sendAnthropicError(res, mapped.status, mapped.type, mapped.message);
    } finally {
      req.off("close", onClientClose);
      res.off("close", onClientClose);
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeSseEvent(res, "ping", { type: "ping" });

  const pingTimer = setInterval(() => {
    writeSseEvent(res, "ping", { type: "ping" });
  }, KEEPALIVE_INTERVAL_MS);

  let nextBlockIndex = 0;
  let activeBlockType: "thinking" | "text" | null = null;
  let activeBlockIndex = -1;
  let emittedText = false;
  let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

  const closeActiveBlock = () => {
    if (activeBlockType === null) return;
    if (activeBlockType === "thinking") {
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: activeBlockIndex,
        delta: { type: "signature_delta", signature: "devin-acp" },
      });
    }
    writeSseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: activeBlockIndex,
    });
    activeBlockType = null;
    activeBlockIndex = -1;
  };

  const ensureBlock = (type: "thinking" | "text") => {
    if (activeBlockType === type) return;
    closeActiveBlock();
    activeBlockIndex = nextBlockIndex++;
    activeBlockType = type;
    writeSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index: activeBlockIndex,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  };

  try {
    const result = await sessions.runTurn(body, {
      cwd,
      signal: controller.signal,
      onThinking: (chunk) => {
        if (!thinkingEnabled || !chunk) return;
        ensureBlock("thinking");
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: activeBlockIndex,
          delta: { type: "thinking_delta", thinking: chunk },
        });
      },
      onText: (chunk) => {
        if (!chunk) return;
        emittedText = true;
        ensureBlock("text");
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: activeBlockIndex,
          delta: { type: "text_delta", text: chunk },
        });
      },
      onUsage: (usage) => {
        latestUsage = usage;
      },
    });

    if (!emittedText && nextBlockIndex === 0) {
      ensureBlock("text");
      writeSseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: activeBlockIndex,
        delta: { type: "text_delta", text: "Done." },
      });
    }
    closeActiveBlock();

    const inputTokens = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(body);
    const outputTokens =
      result.usage.outputTokens ||
      latestUsage.outputTokens ||
      Math.max(1, Math.ceil(result.assistantText.length / 3.5));

    writeSseEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: result.stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    writeSseEvent(res, "message_stop", { type: "message_stop" });
    res.end();
  } catch (err) {
    if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      closeActiveBlock();
      const mapped = errorStatusAndType(err);
      writeSseEvent(res, "error", {
        type: "error",
        error: { type: mapped.type, message: mapped.message },
      });
      res.end();
    }
  } finally {
    clearInterval(pingTimer);
    req.off("close", onClientClose);
    res.off("close", onClientClose);
  }
}
