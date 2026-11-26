import http from "node:http";
import { resolve } from "node:path";
import { estimateInputTokens, handleMessagesRequest, sendAnthropicError } from "./anthropic.mjs";
import { formatAnthropicModelsList } from "./models.mjs";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error("Request body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectPromise(Object.assign(new Error("Invalid JSON body."), { status: 400 }));
      }
    });

    req.on("error", rejectPromise);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req, expectedKey) {
  if (!expectedKey) return true;
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim() === expectedKey) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === expectedKey;
  }
  return false;
}

function resolveRequestCwd(req, defaultCwd) {
  const headerCwd = req.headers["x-devin-cwd"] ?? req.headers["x-cwd"];
  if (typeof headerCwd === "string" && headerCwd.trim()) {
    return resolve(headerCwd.trim());
  }
  return defaultCwd;
}

export function createProxyServer({ config, acp, sessions }) {
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
        if (sessions.catalog.models.length === 0) {
          await sessions.warmUp();
        }
        sendJson(res, 200, formatAnthropicModelsList(sessions.catalog.models, config.defaultModel));
      } catch (err) {
        sendAnthropicError(res, 502, "api_error", err?.message || "Failed to load models from devin acp.");
      }
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, { input_tokens: estimateInputTokens(body) });
      } catch (err) {
        sendAnthropicError(res, err?.status || 400, "invalid_request_error", err?.message || "Invalid request.");
      }
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendAnthropicError(res, err?.status || 400, "invalid_request_error", err?.message || "Invalid request.");
        return;
      }

      if (config.debug) {
        console.error(`[http] POST ${path} model=${body?.model} stream=${Boolean(body?.stream)} msgs=${body?.messages?.length ?? 0}`);
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
