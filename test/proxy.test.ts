import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpClient } from "../src/acp-client.js";
import { formatAnthropicModelsList, parseConfigCatalog, resolveDevinModel, resolveThoughtLevel } from "../src/models.js";
import { createProxyServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";
import type { AnthropicModelsListResponse, ProxyConfig } from "../src/types.js";

function createFakeAcpFixture(): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "devin-proxy-test-"));
  const scriptPath = join(dir, "fake-acp.mjs");
  const script = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextSess = 1;
const sessions = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (msg.method === "session/new") {
    const sid = "sess-" + nextSess++;
    const state = { model: "swe-2-1-medium", mode: "accept-edits", thought: "high", turns: 0, pendingPromptId: null };
    sessions.set(sid, state);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: sid,
        configOptions: [
          {
            id: "mode",
            category: "mode",
            type: "select",
            currentValue: state.mode,
            options: [{ value: "accept-edits", name: "Code" }, { value: "bypass", name: "Bypass" }, { value: "ask", name: "Ask" }]
          },
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: state.model,
            options: [
              { value: "swe-2-1-medium", name: "SWE-2.1", _meta: { "cognition.ai/supportsImages": true } },
              { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5", _meta: { "cognition.ai/supportsImages": true } },
              { value: "gemini-4-carbon-medium", name: "Gemini 4 Carbon", _meta: { "cognition.ai/supportsImages": true } },
              { value: "deepseek-v4-pro-high", name: "DeepSeek V4 Pro", _meta: { "cognition.ai/supportsImages": false } },
              { value: "claude-opus-4-6-1m", name: "Claude Opus 4.6 1M", _meta: { "cognition.ai/supportsImages": true } }
            ]
          },
          {
            id: "thought_level",
            category: "thought_level",
            type: "select",
            currentValue: state.thought,
            options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "max", name: "Max" }]
          }
        ]
      }
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    const state = sessions.get(msg.params.sessionId);
    if (state) {
      if (msg.params.configId === "model") state.model = msg.params.value;
      if (msg.params.configId === "mode") state.mode = msg.params.value;
      if (msg.params.configId === "thought_level") state.thought = msg.params.value;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const state = sessions.get(sid);
    state.turns += 1;
    const text = (msg.params.prompt || []).map((b) => b.text || "[img:" + b.mimeType + "]").join(" ");

    if (text.includes("ASK_PERM")) {
      state.pendingPromptId = msg.id;
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { toolCallId: "tc-1", title: "Run command" },
          options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }]
        }
      });
      return;
    }

    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking on " + state.model } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read file", status: "completed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sid + "#" + state.turns + " model=" + state.model + " mode=" + state.mode + " thought=" + state.thought + " prompt=" + text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 42, outputTokens: 17 } } });
    return;
  }
  if (msg.id === 9001 && msg.result) {
    for (const [sid, state] of sessions) {
      if (state.pendingPromptId) {
        const pid = state.pendingPromptId;
        state.pendingPromptId = null;
        const selected = msg.result?.outcome?.optionId || "none";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm=" + selected } } } });
        send({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } });
      }
    }
    return;
  }
  if (msg.method === "session/close") {
    sessions.delete(msg.params.sessionId);
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;
  writeFileSync(scriptPath, script, "utf8");
  return { dir, scriptPath };
}

function parseSseEvents(raw: string): Array<{ event: string | null; data: Record<string, unknown> | null }> {
  return raw
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      let event: string | null = null;
      let data: Record<string, unknown> | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data = JSON.parse(line.slice(6)) as Record<string, unknown>;
      }
      return { event, data };
    });
}

test("model catalog parsing and resolution handles exact, Anthropic aliases, DeepSeek, and [1m] variants", () => {
  const catalog = parseConfigCatalog([
    {
      id: "model",
      currentValue: "swe-2-high",
      options: [
        { value: "swe-2-1-medium", name: "SWE-2.1", _meta: { "cognition.ai/supportsImages": true } },
        { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5", _meta: { "cognition.ai/supportsImages": true } },
        { value: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5", _meta: { "cognition.ai/supportsImages": true } },
        { value: "claude-haiku-5-5-medium", name: "Claude Haiku 5.5", _meta: { "cognition.ai/supportsImages": true } },
        { value: "gemini-4-carbon-medium", name: "Gemini 4 Carbon", _meta: { "cognition.ai/supportsImages": true } },
        { value: "deepseek-v4-pro-high", name: "DeepSeek V4 Pro", _meta: { "cognition.ai/supportsImages": false } },
        { value: "claude-opus-4-6-1m", name: "Claude Opus 4.6 1M", _meta: { "cognition.ai/supportsImages": true } },
      ],
    },
    {
      id: "thought_level",
      currentValue: "high",
      options: [{ value: "medium" }, { value: "high" }, { value: "max" }],
    },
  ]);

  assert.equal(resolveDevinModel("gemini-4-carbon-medium", catalog.models).id, "gemini-4-carbon-medium");
  assert.equal(resolveDevinModel("claude-3-5-haiku-20241022", catalog.models).id, "claude-haiku-5-5-medium");
  assert.equal(resolveDevinModel("claude-sonnet-4-5-20250929", catalog.models).id, "claude-sonnet-5-5-medium");
  assert.equal(resolveDevinModel("opus", catalog.models).id, "claude-opus-5-5-medium");
  assert.equal(resolveDevinModel("deepseek-v4-pro-high", catalog.models).id, "deepseek-v4-pro-high");
  assert.equal(resolveDevinModel("deepseek-v4-pro-high[1m]", catalog.models).id, "deepseek-v4-pro-high");
  assert.equal(resolveDevinModel("claude-opus-4-6[1m]", catalog.models).id, "claude-opus-4-6-1m");
  assert.equal(resolveDevinModel("deepseek", catalog.models).id, "deepseek-v4-pro-high");
  assert.equal(
    resolveDevinModel("claude-opus-4", catalog.models, { modelMap: { "claude-opus-4": "deepseek-v4-pro-high" } }).id,
    "deepseek-v4-pro-high",
  );
  assert.equal(resolveThoughtLevel({ type: "enabled", budget_tokens: 32000 }, null, catalog.thoughtLevels), "max");

  const formatted = formatAnthropicModelsList(catalog.models, "swe-2-1-medium");
  assert.equal(formatted.data.length, 7);
  assert.equal(formatted.data[0]?.type, "model");
  assert.equal(formatted.data[5]?.max_input_tokens, 1_000_000);
  assert.equal(formatted.data[1]?.line, "opus");
  assert.equal(formatted.has_more, false);
});

test("end-to-end Anthropic server over fake ACP handles auth, models, JSON, SSE, session continuation, images, and permissions", async () => {
  const fixture = createFakeAcpFixture();
  const config: ProxyConfig = {
    help: false,
    host: "127.0.0.1",
    port: 0,
    devinPath: process.execPath,
    acpArgs: [fixture.scriptPath],
    cwd: fixture.dir,
    mode: "bypass",
    defaultModel: "swe-2-1-medium",
    thoughtLevel: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: "secret-key",
    modelMap: {},
    requestTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    idleSessionTtlMs: 60_000,
    maxSessions: 4,
    debug: false,
  };

  const acp = new AcpClient(config);
  const sessions = new SessionManager(acp, config);
  const server = createProxyServer({ config, acp, sessions });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauth = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauth.status, 401);

    const modelsRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { "x-api-key": "secret-key" },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as AnthropicModelsListResponse;
    assert.equal(modelsJson.data.length, 5);
    assert.equal(modelsJson.data[2]?.id, "gemini-4-carbon-medium");

    const countRes = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "swe-2-1-medium", messages: [{ role: "user", content: "hello world" }] }),
    });
    assert.equal(countRes.status, 200);
    const countJson = (await countRes.json()) as { input_tokens: number };
    assert.ok(countJson.input_tokens > 0);

    const turn1Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-4-carbon-medium",
        system: "Be brief",
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 20000 },
        messages: [{ role: "user", content: "first question" }],
      }),
    });
    assert.equal(turn1Res.status, 200);
    const turn1Json = (await turn1Res.json()) as {
      type: string;
      model: string;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };
    assert.equal(turn1Json.type, "message");
    assert.equal(turn1Json.model, "gemini-4-carbon-medium");
    assert.equal(turn1Json.stop_reason, "end_turn");
    assert.equal(turn1Json.usage.input_tokens, 42);
    assert.equal(turn1Json.usage.output_tokens, 17);
    assert.equal(turn1Json.content[0]?.type, "thinking");
    assert.match(turn1Json.content[0]?.thinking ?? "", /Thinking on gemini-4-carbon-medium/);
    assert.match(turn1Json.content[0]?.thinking ?? "", /\[Devin tool completed\] Read file/);
    assert.equal(turn1Json.content[1]?.type, "text");
    const firstAssistantText = turn1Json.content[1]?.text ?? "";
    assert.match(firstAssistantText, /^sess-2#1 model=gemini-4-carbon-medium mode=bypass thought=max/);
    assert.match(firstAssistantText, /<system_instructions>\nBe brief\n<\/system_instructions>/);

    const turn2Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5-medium",
        system: "Be brief",
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "user", content: "first question" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "ignored", signature: "sig" },
              { type: "text", text: firstAssistantText },
            ],
          },
          { role: "user", content: "follow up" },
        ],
      }),
    });
    assert.equal(turn2Res.status, 200);
    const sseRaw = await turn2Res.text();
    const events = parseSseEvents(sseRaw);
    assert.equal(events[0]?.event, "message_start");
    assert.equal(events.at(-1)?.event, "message_stop");

    const textDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data?.delta as { type?: string } | undefined)?.type === "text_delta")
      .map((e) => (e.data?.delta as { text: string }).text)
      .join("");
    assert.match(textDeltas, /^sess-2#2 model=claude-opus-5-5-medium/);
    assert.match(textDeltas, /prompt=follow up$/);

    const sigDelta = events.find(
      (e) => e.event === "content_block_delta" && (e.data?.delta as { type?: string } | undefined)?.type === "signature_delta",
    );
    assert.ok(sigDelta, "thinking block should emit signature_delta before stop");

    const permRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro-high",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "ASK_PERM" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      }),
    });
    assert.equal(permRes.status, 200);
    const permJson = (await permRes.json()) as { content: Array<{ text?: string }> };
    assert.equal(permJson.content[0]?.text, "perm=allow-once");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sessions.closeAll();
    await acp.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
