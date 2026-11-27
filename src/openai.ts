import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AcpRpcError } from "./acp-client.js";
import { estimateInputTokens, type TurnRunner } from "./anthropic.js";
import type { AnthropicContentBlock, AnthropicMessageParam, AnthropicMessagesRequest, ThoughtLevel, TurnUsage } from "./types.js";

const EFFORT_VALUES = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeEffortValue(val: unknown): ThoughtLevel | undefined {
  if (typeof val !== "string") return undefined;
  const lower = val.trim().toLowerCase();
  if (lower === "extra") return "xhigh";
  return EFFORT_VALUES.has(lower) ? (lower as ThoughtLevel) : undefined;
}

export function sendOpenAIError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSseData(res: ServerResponse, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`data: ${serialized}\n\n`);
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function normalizeOpenAIContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const rec = part as Record<string, unknown>;
    const kind = typeof rec.type === "string" ? rec.type : "";
    if (kind === "text" || kind === "input_text" || kind === "output_text") {
      if (typeof rec.text === "string" && rec.text) {
        blocks.push({ type: "text", text: rec.text });
      }
    } else if (kind === "image_url" || kind === "input_image") {
      const urlObj = rec.image_url;
      const urlStr =
        typeof urlObj === "string"
          ? urlObj
          : urlObj && typeof urlObj === "object" && typeof (urlObj as Record<string, unknown>).url === "string"
            ? ((urlObj as Record<string, unknown>).url as string)
            : typeof rec.url === "string"
              ? rec.url
              : "";
      if (urlStr.startsWith("data:")) {
        const idx = urlStr.indexOf(";base64,");
        if (idx > 5) {
          const mediaType = urlStr.slice(5, idx);
          const data = urlStr.slice(idx + 8);
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          });
        }
      }
    }
  }
  return blocks;
}

function errorStatusAndType(err: unknown): { status: number; type: string; message: string } {
  const isAuth = err instanceof AcpRpcError && err.isAuthError;
  const message = err instanceof Error ? err.message : "Backend execution failed.";
  return {
    status: isAuth ? 401 : 502,
    type: isAuth ? "authentication_error" : "server_error",
    message,
  };
}

/**
 * Handle POST /v1/chat/completions (streaming SSE & non-streaming JSON).
 */
export async function handleOpenAIChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  context: { sessions: TurnRunner; cwd: string; defaultModel: string },
): Promise<void> {
  const rawMsgs = body?.messages;
  if (!body || typeof body !== "object" || !Array.isArray(rawMsgs) || rawMsgs.length === 0) {
    sendOpenAIError(res, 400, "invalid_request_error", "Field 'messages' must be a non-empty array.");
    return;
  }

  const requestedModel =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : context.defaultModel;
  const sysParts: string[] = [];
  const messages: AnthropicMessageParam[] = [];

  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role : "user";
    const blocks = normalizeOpenAIContent(rec.content);
    if (role === "system" || role === "developer") {
      const txt = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim();
      if (txt) sysParts.push(txt);
    } else if (blocks.length > 0) {
      messages.push({
        role: role === "assistant" ? "assistant" : "user",
        content: blocks,
      });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }

  const reasoningObj = body.reasoning && typeof body.reasoning === "object" ? (body.reasoning as Record<string, unknown>) : null;
  const effort = normalizeEffortValue(body.reasoning_effort ?? reasoningObj?.effort);

  const anthropicReq: AnthropicMessagesRequest = {
    model: requestedModel,
    system: sysParts.length > 0 ? sysParts.join("\n\n") : undefined,
    messages,
    stream: body.stream === true,
    ...(effort ? { output_config: { effort } } : {}),
  };

  const reqId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  req.on("close", onClose);
  res.on("close", onClose);

  if (anthropicReq.stream !== true) {
    try {
      let thinking = "";
      let text = "";
      let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

      const result = await context.sessions.runTurn(anthropicReq, {
        cwd: context.cwd,
        signal: controller.signal,
        onThinking: (chunk) => {
          thinking += chunk;
        },
        onText: (chunk) => {
          text += chunk;
        },
        onUsage: (u) => {
          latestUsage = u;
        },
      });

      const assistantText = text || result.assistantText || "Done.";
      const inTok = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(anthropicReq);
      const outTok =
        result.usage.outputTokens ||
        latestUsage.outputTokens ||
        Math.max(1, Math.ceil((assistantText.length + thinking.length) / 3.5));

      const msgObj: Record<string, unknown> = {
        role: "assistant",
        content: assistantText,
      };
      if (thinking) {
        msgObj.reasoning_content = thinking;
      }

      const payload = JSON.stringify({
        id: reqId,
        object: "chat.completion",
        created,
        model: result.modelId || requestedModel,
        choices: [
          {
            index: 0,
            message: msgObj,
            finish_reason: result.stopReason === "max_tokens" ? "length" : "stop",
          },
        ],
        usage: {
          prompt_tokens: inTok,
          completion_tokens: outTok,
          total_tokens: inTok + outTok,
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
      sendOpenAIError(res, mapped.status, mapped.type, mapped.message);
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  writeSseData(res, {
    id: reqId,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };
  let thinkingLen = 0;

  try {
    const result = await context.sessions.runTurn(anthropicReq, {
      cwd: context.cwd,
      signal: controller.signal,
      onThinking: (chunk) => {
        if (!chunk) return;
        thinkingLen += chunk.length;
        writeSseData(res, {
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
        });
      },
      onText: (chunk) => {
        if (!chunk) return;
        writeSseData(res, {
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
      },
      onUsage: (u) => {
        latestUsage = u;
      },
    });

    const inTok = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(anthropicReq);
    const outTok =
      result.usage.outputTokens ||
      latestUsage.outputTokens ||
      Math.max(1, Math.ceil((result.assistantText.length + thinkingLen) / 3.5));

    writeSseData(res, {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: result.modelId || requestedModel,
      choices: [{ index: 0, delta: {}, finish_reason: result.stopReason === "max_tokens" ? "length" : "stop" }],
      usage: {
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: inTok + outTok,
      },
    });
    writeSseData(res, "[DONE]");
    res.end();
  } catch (err) {
    if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      const mapped = errorStatusAndType(err);
      writeSseData(res, { error: { message: mapped.message, type: mapped.type } });
      writeSseData(res, "[DONE]");
      res.end();
    }
  } finally {
    req.off("close", onClose);
    res.off("close", onClose);
  }
}

/**
 * Handle POST /v1/responses (OpenAI Responses API / Codex CLI compatible).
 */
export async function handleOpenAIResponsesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  context: { sessions: TurnRunner; cwd: string; defaultModel: string },
): Promise<void> {
  if (!body || typeof body !== "object") {
    sendOpenAIError(res, 400, "invalid_request_error", "Invalid JSON body.");
    return;
  }

  const requestedModel =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : context.defaultModel;
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;

  const messages: AnthropicMessageParam[] = [];
  const inp = body.input;
  if (typeof inp === "string") {
    if (inp.trim()) messages.push({ role: "user", content: [{ type: "text", text: inp }] });
  } else if (Array.isArray(inp)) {
    for (const item of inp) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const itemType = typeof rec.type === "string" ? rec.type : "message";
      if (itemType === "message" || rec.role !== undefined) {
        const role = typeof rec.role === "string" ? rec.role : "user";
        const blocks = normalizeOpenAIContent(rec.content);
        if (blocks.length > 0) {
          messages.push({
            role: role === "assistant" ? "assistant" : "user",
            content: blocks,
          });
        }
      } else if (itemType === "function_call_output") {
        const output = typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? "");
        messages.push({
          role: "user",
          content: [{ type: "text", text: `[Tool Result]\n${output}` }],
        });
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }

  const reasoningObj = body.reasoning && typeof body.reasoning === "object" ? (body.reasoning as Record<string, unknown>) : null;
  const effort = normalizeEffortValue(reasoningObj?.effort ?? body.reasoning_effort);

  const anthropicReq: AnthropicMessagesRequest = {
    model: requestedModel,
    system: instructions,
    messages,
    stream: body.stream === true,
    ...(effort ? { output_config: { effort } } : {}),
  };

  const respId = `resp_${randomUUID().replaceAll("-", "")}`;
  const msgId = `msg_${randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  req.on("close", onClose);
  res.on("close", onClose);

  if (anthropicReq.stream !== true) {
    try {
      let thinkingLen = 0;
      let text = "";
      let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

      const result = await context.sessions.runTurn(anthropicReq, {
        cwd: context.cwd,
        signal: controller.signal,
        onThinking: (chunk) => {
          thinkingLen += chunk.length;
        },
        onText: (chunk) => {
          text += chunk;
        },
        onUsage: (u) => {
          latestUsage = u;
        },
      });

      const assistantText = text || result.assistantText || "Done.";
      const inTok = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(anthropicReq);
      const outTok =
        result.usage.outputTokens ||
        latestUsage.outputTokens ||
        Math.max(1, Math.ceil((assistantText.length + thinkingLen) / 3.5));

      const payload = JSON.stringify({
        id: respId,
        object: "response",
        created_at: createdAt,
        status: "completed",
        model: result.modelId || requestedModel,
        output: [
          {
            id: msgId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: assistantText, annotations: [] }],
          },
        ],
        output_text: assistantText,
        usage: {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: inTok + outTok,
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
      sendOpenAIError(res, mapped.status, mapped.type, mapped.message);
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  writeSseEvent(res, "response.created", {
    type: "response.created",
    response: { id: respId, object: "response", created_at: createdAt, status: "in_progress", model: requestedModel, output: [] },
  });
  writeSseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
  });
  writeSseEvent(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  let text = "";
  let thinkingLen = 0;
  let latestUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

  try {
    const result = await context.sessions.runTurn(anthropicReq, {
      cwd: context.cwd,
      signal: controller.signal,
      onThinking: (chunk) => {
        if (!chunk) return;
        thinkingLen += chunk.length;
        writeSseEvent(res, "response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          delta: chunk,
        });
      },
      onText: (chunk) => {
        if (!chunk) return;
        text += chunk;
        writeSseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: chunk,
        });
      },
      onUsage: (u) => {
        latestUsage = u;
      },
    });

    const finalText = text || result.assistantText;
    const inTok = result.usage.inputTokens || latestUsage.inputTokens || estimateInputTokens(anthropicReq);
    const outTok =
      result.usage.outputTokens ||
      latestUsage.outputTokens ||
      Math.max(1, Math.ceil((finalText.length + thinkingLen) / 3.5));

    writeSseEvent(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    });
    writeSseEvent(res, "response.completed", {
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        created_at: createdAt,
        status: "completed",
        model: result.modelId || requestedModel,
        output: [
          {
            id: msgId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: finalText, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: inTok + outTok,
        },
      },
    });
    res.end();
  } catch (err) {
    if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      const mapped = errorStatusAndType(err);
      writeSseEvent(res, "response.failed", {
        type: "response.failed",
        response: { id: respId, status: "failed", error: { message: mapped.message } },
      });
      res.end();
    }
  } finally {
    req.off("close", onClose);
    res.off("close", onClose);
  }
}
