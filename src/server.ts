import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { AcpClient } from "./acp-client.js";
import { estimateInputTokens, handleMessagesRequest, sendAnthropicError } from "./anthropic.js";
import { formatAnthropicModelsList } from "./models.js";
import type { SessionManager } from "./sessions.js";
import type { AnthropicMessagesRequest, ProxyConfig } from "./types.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

class HttpPayloadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectPromise(new HttpPayloadError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise({} as T);
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        rejectPromise(new HttpPayloadError(400, "Invalid JSON body."));
      }
    });

    req.on("error", rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req: IncomingMessage, expectedKey: string | null): boolean {
  if (!expectedKey) return true;
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim() === expectedKey) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === expectedKey;
  }
  return false;
}

function resolveRequestCwd(req: IncomingMessage, defaultCwd: string): string {
  const headerCwd = req.headers["x-devin-cwd"] ?? req.headers["x-cwd"];
  if (typeof headerCwd === "string" && headerCwd.trim()) {
    return resolve(headerCwd.trim());
  }
  return defaultCwd;
}

export function createProxyServer(deps: {
  config: ProxyConfig;
  acp: AcpClient;
  sessions: SessionManager;
}): Server {
  const { config, acp, sessions } = deps;

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname;

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      sendJson(res, 200, {
        ok: true,
        devinReady: acp.isReady,
        modelsCount: sessions.catalog.models.length,
        activeSessions: sessions.activeSessionCount,
        mode: config.mode,
        cwd: config.cwd,
      });
      return;
    }

    if (!isAuthorized(req, config.apiKey)) {
      sendAnthropicError(res, 401, "authentication_error", "Invalid API key.");
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      try {
        const refresh = url.searchParams.get("refresh") === "1";
        if (refresh || sessions.catalog.models.length === 0) {
          await sessions.warmUp(refresh);
        }
        sendJson(res, 200, formatAnthropicModelsList(sessions.catalog.models, config.defaultModel));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load models from devin acp.";
        sendAnthropicError(res, 502, "api_error", message);
      }
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
      try {
        const body = await readJsonBody<Partial<AnthropicMessagesRequest>>(req);
        sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
      } catch (err) {
        const status = err instanceof HttpPayloadError ? err.status : 400;
        const message = err instanceof Error ? err.message : "Invalid request.";
        sendAnthropicError(res, status, "invalid_request_error", message);
      }
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      let body: AnthropicMessagesRequest;
      try {
        body = await readJsonBody<AnthropicMessagesRequest>(req);
      } catch (err) {
        const status = err instanceof HttpPayloadError ? err.status : 400;
        const message = err instanceof Error ? err.message : "Invalid request.";
        sendAnthropicError(res, status, "invalid_request_error", message);
        return;
      }

      if (config.debug) {
        console.error(
          `[http] POST ${path} model=${body?.model} stream=${Boolean(body?.stream)} msgs=${body?.messages?.length ?? 0}`,
        );
      }

      await handleMessagesRequest(req, res, body, {
        sessions,
        cwd: resolveRequestCwd(req, config.cwd),
      });
      return;
    }

    sendAnthropicError(res, 404, "not_found_error", `Unsupported endpoint: ${req.method} ${path}`);
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}
