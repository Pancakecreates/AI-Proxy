import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpClient } from "../src/acp-client.js";
import {
  decodeGatewayModelId,
  fitSupportedEffort,
  formatAnthropicModelsList,
  isClaudeDesktopCompatibleId,
  parseConfigCatalog,
  resolveDevinModelWithHints,
  resolveSpeed,
  resolveThoughtLevel,
  toGatewayModelId,
} from "../src/models.js";
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

const MODEL_CAPABILITIES = {
  "swe-2-1-medium": { thoughts: ["low", "medium", "high", "xhigh", "max"], defaultThought: "medium", speeds: ["standard", "ultrafast"] },
  "claude-opus-5-5-medium": { thoughts: ["low", "medium", "high", "xhigh", "max"], defaultThought: "medium", speeds: ["standard", "fast"] },
  "gemini-4-carbon-medium": { thoughts: ["low", "medium", "high"], defaultThought: "medium", speeds: [] },
  "deepseek-v4-pro-high": { thoughts: ["high", "max"], defaultThought: "high", speeds: [] }
};

function buildConfigOptions(state) {
  const caps = MODEL_CAPABILITIES[state.model] || { thoughts: ["medium", "high", "max"], defaultThought: "high", speeds: [] };
  const opts = [
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
      options: caps.thoughts.map((v) => ({ value: v, name: v }))
    }
  ];
  if (caps.speeds.length > 0) {
    opts.push({
      id: "speed",
      category: "model_config",
      type: "select",
      currentValue: state.speed,
      options: caps.speeds.map((v) => ({ value: v, name: v }))
    });
  }
  return opts;
}

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
    const state = { model: "swe-2-1-medium", mode: "accept-edits", thought: "medium", speed: "standard", turns: 0, pendingPromptId: null };
    sessions.set(sid, state);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid, configOptions: buildConfigOptions(state) } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    const state = sessions.get(msg.params.sessionId);
    if (state) {
      if (msg.params.configId === "model") {
        state.model = msg.params.value;
        const caps = MODEL_CAPABILITIES[state.model];
        if (caps) {
          state.thought = caps.defaultThought;
          state.speed = caps.speeds[0] || "standard";
        }
      }
      if (msg.params.configId === "mode") state.mode = msg.params.value;
      if (msg.params.configId === "thought_level") state.thought = msg.params.value;
      if (msg.params.configId === "speed") state.speed = msg.params.value;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: state ? buildConfigOptions(state) : [] } });
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
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "in_progress", rawInput: { path: "/tmp/readme.txt" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_content_chunk", toolCallId: "t1", content: { type: "content", content: { type: "text", text: "file chunk" } } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "plan", entries: [{ content: "inspect", status: "completed", priority: "high" }, { content: "implement", status: "in_progress", priority: "high" }] } } });
    if (!text.includes("NO_TEXT")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sid + "#" + state.turns + " model=" + state.model + " mode=" + state.mode + " thought=" + state.thought + " speed=" + state.speed + " prompt=" + text } } } });
    }
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

test("model catalog parsing and resolution handles exact, Anthropic aliases, DeepSeek, effort/speed suffixes, and nearest effort fit", () => {
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

  assert.equal(resolveDevinModelWithHints("gemini-4-carbon-medium", catalog.models).model.id, "gemini-4-carbon-medium");
  assert.equal(resolveDevinModelWithHints("claude-3-5-haiku-20241022", catalog.models).model.id, "claude-haiku-5-5-medium");
  assert.equal(resolveDevinModelWithHints("claude-sonnet-4-5-20250929", catalog.models).model.id, "claude-sonnet-5-5-medium");
  assert.equal(resolveDevinModelWithHints("opus", catalog.models).model.id, "claude-opus-5-5-medium");
  assert.equal(resolveDevinModelWithHints("deepseek-v4-pro-high", catalog.models).model.id, "deepseek-v4-pro-high");
  assert.equal(resolveDevinModelWithHints("deepseek-v4-pro-high[1m]", catalog.models).model.id, "deepseek-v4-pro-high");
  assert.equal(resolveDevinModelWithHints("claude-opus-4-6[1m]", catalog.models).model.id, "claude-opus-4-6-1m");
  assert.equal(resolveDevinModelWithHints("deepseek", catalog.models).model.id, "deepseek-v4-pro-high");

  const sweXhigh = resolveDevinModelWithHints("swe-2-1-xhigh-lightning", catalog.models);
  assert.equal(sweXhigh.model.id, "swe-2-1-medium");
  assert.equal(sweXhigh.requestedEffort, "xhigh");
  assert.equal(sweXhigh.requestedSpeed, "ultrafast");

  const dsMax = resolveDevinModelWithHints("deepseek-v4-pro-max", catalog.models);
  assert.equal(dsMax.model.id, "deepseek-v4-pro-high");
  assert.equal(dsMax.requestedEffort, "max");
  assert.equal(dsMax.requestedSpeed, null);

  assert.equal(fitSupportedEffort("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(fitSupportedEffort("medium", ["high", "max"]), "high");
  assert.equal(fitSupportedEffort("xhigh", ["low", "medium", "high", "xhigh", "max"]), "xhigh");

  assert.equal(
    resolveThoughtLevel(
      { outputConfig: { effort: "xhigh" }, defaultThoughtLevel: null },
      ["low", "medium", "high", "xhigh", "max"],
    ),
    "xhigh",
  );
  assert.equal(resolveSpeed("fast", null, ["standard", "ultrafast"]), "ultrafast");

  const formatted = formatAnthropicModelsList(catalog.models, "swe-2-1-medium");
  assert.equal(formatted.data.length, 7);
  assert.equal(formatted.data[0]?.type, "model");
  assert.equal(formatted.data[5]?.max_input_tokens, 1_000_000);
  assert.equal(formatted.data[1]?.id, "claude-opus-5-5-medium");
  assert.equal(formatted.data[1]?.line, "opus");
  assert.equal(isClaudeDesktopCompatibleId(formatted.data[0]!.id), true);
  assert.equal(isClaudeDesktopCompatibleId(formatted.data[4]!.id), true);
  assert.equal(isClaudeDesktopCompatibleId(formatted.data[5]!.id), true);
  assert.equal(formatted.data[5]?.display_name, "DeepSeek V4 Pro");
  assert.equal(formatted.has_more, false);

  const formattedRaw = formatAnthropicModelsList(catalog.models, "swe-2-1-medium", { gatewayAliases: false });
  assert.equal(formattedRaw.data[5]?.id, "deepseek-v4-pro-high");

  // Gateway alias encoding & decoding (including [1m], -max suffixes, safe-hex fallback, and DEVIN_MODEL_MAP [1m])
  for (const id of [
    "swe-2-1-medium",
    "gemini-4-carbon-medium",
    "deepseek-v4-pro-high",
    "gpt-6-2-astra-medium",
    "kimi-k3-1-pro-max",
    "glm-5-3-max",
    "grok-4-7-medium",
    "nemotron-3-5-super-high",
    "fusion-claude-opus-5-5-medium-sidekick-gpt-6-luna-high",
    "custom--double-dash-qwen-codex",
  ]) {
    const alias = toGatewayModelId(id);
    assert.equal(isClaudeDesktopCompatibleId(alias), true, `Alias should pass Claude Desktop filter: ${alias}`);
    assert.equal(decodeGatewayModelId(alias), id);
  }

  const dsAlias = toGatewayModelId("deepseek-v4-pro-high");
  assert.equal(resolveDevinModelWithHints(`${dsAlias}[1m]`, catalog.models).model.id, "deepseek-v4-pro-high");
  const dsAliasMax = toGatewayModelId("deepseek-v4-pro-max");
  const resolvedAliasMax = resolveDevinModelWithHints(dsAliasMax, catalog.models);
  assert.equal(resolvedAliasMax.model.id, "deepseek-v4-pro-high");
  assert.equal(resolvedAliasMax.requestedEffort, "max");
  assert.equal(
    resolveDevinModelWithHints("anthropic/dp-v4-pro-high[1m]", catalog.models, {
      modelMap: { "anthropic/dp-v4-pro-high": "deepseek-v4-pro-high" },
    }).model.id,
    "deepseek-v4-pro-high",
  );
});

test("end-to-end Anthropic server over fake ACP handles per-model efforts, output_config.effort, speed suffixes, SSE, and permissions", async () => {
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
    speed: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: "secret-key",
    modelMap: {},
    gatewayAliases: true,
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
    for (const m of modelsJson.data) {
      assert.equal(isClaudeDesktopCompatibleId(m.id), true, `GET /v1/models exposed incompatible ID: ${m.id}`);
    }

    const rawModelsRes = await fetch(`${baseUrl}/v1/models?raw=1`, {
      headers: { "x-api-key": "secret-key" },
    });
    const rawModelsJson = (await rawModelsRes.json()) as AnthropicModelsListResponse;
    assert.ok(rawModelsJson.data.some((m) => m.id === "deepseek-v4-pro-high"));

    const countRes = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "swe-2-1-medium", messages: [{ role: "user", content: "hello world" }] }),
    });
    assert.equal(countRes.status, 200);
    const countJson = (await countRes.json()) as { input_tokens: number };
    assert.ok(countJson.input_tokens > 0);

    // 1. output_config.effort=xhigh on claude-opus-5-5-medium -> sets thought=xhigh; speed suffix via model works too
    const turn1Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5-medium",
        system: "Be brief",
        max_tokens: 1024,
        output_config: { effort: "xhigh" },
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
    const firstAssistantText = turn1Json.content[1]?.text ?? "";
    assert.match(firstAssistantText, /^sess-2#1 model=claude-opus-5-5-medium mode=bypass thought=xhigh speed=standard/);
    const firstThinking = turn1Json.content[0]?.thinking ?? "";
    assert.match(firstThinking, /\[Devin tool\] Read file — \/tmp\/readme\.txt\.\.\./);
    assert.match(firstThinking, /\[Devin tool completed\] Read file — \/tmp\/readme\.txt/);
    assert.match(firstThinking, /output: file chunk/);
    assert.match(firstThinking, /\[Devin plan\] 1\/2 completed — implement/);
    assert.equal((turn1Json.content[0] as Record<string, unknown>).signature, undefined);

    const silentRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "swe-2-1-medium",
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "NO_TEXT silent turn" }],
      }),
    });
    assert.equal(silentRes.status, 200);
    const silentJson = (await silentRes.json()) as { content: Array<{ type: string; text?: string }> };
    assert.equal(silentJson.content.length, 0);
    assert.equal(silentJson.content.some((block) => block.text === "Done."), false);

    // 2. Streaming SSE turn 2 continues session, switches via suffix to swe-2-1-xhigh-lightning -> swe-2-1-medium + thought=xhigh + speed=ultrafast
    const turn2Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "swe-2-1-xhigh-lightning",
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
    const events = parseSseEvents(await turn2Res.text());
    const textDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data?.delta as { type?: string } | undefined)?.type === "text_delta")
      .map((e) => (e.data?.delta as { text: string }).text)
      .join("");
    assert.match(textDeltas, /^sess-2#2 model=swe-2-1-medium mode=bypass thought=xhigh speed=ultrafast/);
    assert.equal(
      events.some((e) => (e.data?.delta as { type?: string } | undefined)?.type === "signature_delta"),
      false,
    );

    // 3. deepseek-v4-pro-max selects deepseek-v4-pro-high + thought=max
    const dsRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro-max",
        messages: [{ role: "user", content: "hi deepseek" }],
      }),
    });
    assert.equal(dsRes.status, 200);
    const dsJson = (await dsRes.json()) as { content: Array<{ text?: string }> };
    assert.match(dsJson.content[1]?.text ?? "", /model=deepseek-v4-pro-high mode=bypass thought=max/);

    // 3b. Claude Desktop Gateway aliased DeepSeek with [1m] + effort=max routes back to deepseek-v4-pro-high
    const dsGatewayId = modelsJson.data.find((m) => m.display_name === "DeepSeek V4 Pro")?.id;
    assert.ok(dsGatewayId);
    const dsAliasRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${dsGatewayId}[1m]`,
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "hi gateway deepseek" }],
      }),
    });
    assert.equal(dsAliasRes.status, 200);
    const dsAliasJson = (await dsAliasRes.json()) as { content: Array<{ text?: string }> };
    assert.match(dsAliasJson.content[1]?.text ?? "", /model=deepseek-v4-pro-high mode=bypass thought=max/);

    // 4. Permission auto-approval
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

import { CodexBackend } from "../src/codex-client.js";
import { filterOpencodeModels, isFreeOpencodeModel } from "../src/models.js";
import { BackendRouter } from "../src/router.js";
import { AcpProxyBackend } from "../src/sessions.js";

function createFakeCodexScript(dir: string): string {
  const scriptPath = join(dir, "fake-codex.mjs");
  const script = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextThread = 1;
let nextTurn = 1;
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (msg.method === "model/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        data: [
          {
            id: "gpt-6-luna",
            model: "gpt-6-luna",
            displayName: "GPT-6 Luna",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
              { reasoningEffort: "xhigh" }
            ],
            inputModalities: ["text", "image"]
          }
        ]
      }
    });
    return;
  }
  if (msg.method === "thread/start") {
    const tid = "thr-" + nextThread++;
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: tid }, model: msg.params.model } });
    return;
  }
  if (msg.method === "turn/start") {
    const tid = msg.params.threadId;
    const turnId = "turn-" + nextTurn++;
    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: tid, turn: { id: turnId, status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: tid, turnId, itemId: "r1", delta: "Codex thinking..." } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: tid, turnId, item: { id: "cmd1", type: "commandExecution", command: "npm test", status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { threadId: tid, turnId, itemId: "cmd1", delta: "tests passed\\n" } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: tid, turnId, item: { id: "cmd1", type: "commandExecution", command: "npm test", status: "completed" } } });
    send({ jsonrpc: "2.0", method: "item/mcpToolCall/progress", params: { threadId: tid, turnId, itemId: "mcp1", message: "loading schema" } });
    const promptText = (msg.params.input || []).map((b) => b.text || "[img]").join(" ");
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: tid, turnId, itemId: "m1", delta: tid + ":" + msg.params.model + ":effort=" + (msg.params.effort || "none") + ":" + promptText } });
    send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: tid, turnId, tokenUsage: { total: { inputTokens: 15, outputTokens: 9 } } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: tid, turn: { id: turnId, status: "completed", error: null } } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function createFakeProviderAcpScript(dir: string, filename: string, opts: {
  requireAuth?: string;
  thoughtId: string;
  thoughtValues: string[];
  models: Array<{ value: string; name: string }>;
  tag: string;
}): string {
  const scriptPath = join(dir, filename);
  const script = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let authed = ${opts.requireAuth ? "false" : "true"};
let nextSess = 1;
const sessions = new Map();
const MODELS = ${JSON.stringify(opts.models)};
const THOUGHT_ID = ${JSON.stringify(opts.thoughtId)};
const THOUGHT_VALUES = ${JSON.stringify(opts.thoughtValues)};
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: ${opts.requireAuth ? JSON.stringify([{ id: opts.requireAuth }]) : "[]"} } });
    return;
  }
  if (msg.method === "authenticate") {
    if (msg.params?.methodId === ${JSON.stringify(opts.requireAuth ?? "")}) authed = true;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new") {
    if (!authed) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Auth required" } }); return; }
    const sid = ${JSON.stringify(opts.tag)} + "-s" + nextSess++;
    const state = { model: MODELS[0].value, thought: THOUGHT_VALUES[0] };
    sessions.set(sid, state);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: sid,
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: state.model, options: MODELS },
          { id: THOUGHT_ID, category: "thought_level", type: "select", currentValue: state.thought, options: THOUGHT_VALUES.map(v => ({ value: v, name: v })) }
        ]
      }
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    const st = sessions.get(msg.params.sessionId);
    if (st) {
      if (msg.params.configId === "model") st.model = msg.params.value;
      if (msg.params.configId === THOUGHT_ID) st.thought = msg.params.value;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const st = sessions.get(sid);
    const text = (msg.params.prompt || []).map(b => b.text || "").join(" ");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(opts.tag)} + ":" + st.model + ":" + THOUGHT_ID + "=" + st.thought + ":" + text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 4 } } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

test("OpenCode Go + free model filtering matches OpenCode Go and free models only", () => {
  const sample = [
    { id: "opencode-go/kimi-k3.1-pro", name: "opencode-go/Kimi K3.1 Pro", supportsImages: true },
    { id: "opencode/beam-free", name: "opencode/Beam Free", supportsImages: true },
    { id: "opencode/big-pickle", name: "opencode/Big Pickle", supportsImages: true },
    { id: "opencode/claude-opus-4-6", name: "opencode/Claude Opus 4.6", supportsImages: true },
    { id: "openai/gpt-5.4", name: "openai/GPT-5.4", supportsImages: true },
  ];
  assert.equal(isFreeOpencodeModel("opencode/big-pickle", "opencode/Big Pickle"), true);
  assert.equal(isFreeOpencodeModel("opencode/beam-free", "opencode/Beam Free"), true);
  assert.equal(isFreeOpencodeModel("opencode/claude-opus-4-6", "opencode/Claude Opus 4.6"), false);

  const goFree = filterOpencodeModels(sample, "go-free");
  assert.deepEqual(
    goFree.map((m) => m.id),
    ["opencode-go/kimi-k3.1-pro", "opencode/beam-free", "opencode/big-pickle"],
  );

  const custom = filterOpencodeModels(sample, "custom", ["openai"]);
  assert.deepEqual(
    custom.map((m) => m.id),
    ["openai/gpt-5.4"],
  );
});

test("Multi-backend router routes across Antigravity accounts, OpenCode Go/Free, Grok ACP, and Codex app-server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-proxy-test-"));
  const agy1Script = createFakeProviderAcpScript(dir, "fake-agy1.mjs", {
    thoughtId: "thought_level",
    thoughtValues: ["low", "medium", "high", "xhigh"],
    models: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
    tag: "agy1",
  });
  const agy2Script = createFakeProviderAcpScript(dir, "fake-agy2.mjs", {
    thoughtId: "thought_level",
    thoughtValues: ["low", "medium", "high", "xhigh"],
    models: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
    tag: "agy2",
  });
  const ocScript = createFakeProviderAcpScript(dir, "fake-oc.mjs", {
    thoughtId: "effort",
    thoughtValues: ["low", "medium", "high", "extra", "max"],
    models: [
      { value: "opencode-go/kimi-k3.1-pro", name: "opencode-go/Kimi K3.1 Pro" },
      { value: "opencode/beam-free", name: "opencode/Beam Free" },
      { value: "openai/gpt-paid", name: "openai/GPT Paid" },
    ],
    tag: "oc",
  });
  const grokScript = createFakeProviderAcpScript(dir, "fake-grok.mjs", {
    requireAuth: "cached_token",
    thoughtId: "reasoning_effort",
    thoughtValues: ["low", "medium", "high", "xhigh"],
    models: [{ value: "grok-4.7", name: "Grok 4.7" }],
    tag: "grok",
  });
  const codexScript = createFakeCodexScript(dir);

  const config: ProxyConfig = {
    help: false,
    host: "127.0.0.1",
    port: 0,
    devinPath: process.execPath,
    cwd: dir,
    mode: "bypass",
    defaultModel: "gemini-4-hydrogen",
    thoughtLevel: null,
    speed: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: null,
    modelMap: {},
    gatewayAliases: true,
    requestTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    idleSessionTtlMs: 60_000,
    maxSessions: 4,
    debug: false,
  };

  const agy1Acp = new AcpClient(config, { label: "Antigravity (Acc1)", executable: process.execPath, args: [agy1Script], supportsCloseSession: false });
  const agy2Acp = new AcpClient(config, { label: "Antigravity (Acc2)", executable: process.execPath, args: [agy2Script], supportsCloseSession: false });
  const ocAcp = new AcpClient(config, { label: "OpenCode", executable: process.execPath, args: [ocScript], supportsCloseSession: false });
  const grokAcp = new AcpClient(config, { label: "Grok", executable: process.execPath, args: [grokScript], authMethodIds: ["cached_token"], supportsCloseSession: false });

  const router = new BackendRouter(
    [
      new AcpProxyBackend({
        key: "antigravity:acc1",
        kind: "antigravity",
        label: "Antigravity 1 (acc1@gmail.com)",
        acp: agy1Acp,
        sessions: new SessionManager(agy1Acp, config, { backendKind: "antigravity", backendLabel: "Antigravity 1" }),
        qualifiedPrefix: "agy-acc1.",
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `Antigravity 1: ${m.id}`,
      }),
      new AcpProxyBackend({
        key: "antigravity:acc2",
        kind: "antigravity",
        label: "Antigravity 2 (acc2@gmail.com)",
        acp: agy2Acp,
        sessions: new SessionManager(agy2Acp, config, { backendKind: "antigravity", backendLabel: "Antigravity 2" }),
        qualifiedPrefix: "agy-acc2.",
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `Antigravity 2: ${m.id}`,
      }),
      new AcpProxyBackend({
        key: "opencode",
        kind: "opencode",
        label: "OpenCode",
        acp: ocAcp,
        sessions: new SessionManager(ocAcp, config, {
          backendKind: "opencode",
          backendLabel: "OpenCode",
          filterModels: (models) => filterOpencodeModels(models, "go-free"),
        }),
        qualifiedPrefix: "oc.",
        formatQualifiedId: (m) =>
          m.id.startsWith("opencode-go/")
            ? `oc-go.${m.id.slice("opencode-go/".length)}`
            : `oc-free.${m.id.replace(/^opencode\//, "")}`,
        formatDisplayName: (m) => m.name.replace(/^(?:opencode-go|opencode)\//i, ""),
        formatDescription: (m) =>
          m.id.startsWith("opencode-go/")
            ? `OpenCode Go: ${m.id.slice("opencode-go/".length)}`
            : `OpenCode: ${m.id.replace(/^opencode\//i, "")}`,
      }),
      new AcpProxyBackend({
        key: "grok",
        kind: "grok",
        label: "Grok",
        acp: grokAcp,
        sessions: new SessionManager(grokAcp, config, { backendKind: "grok", backendLabel: "Grok" }),
        qualifiedPrefix: "grok.",
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `Grok: ${m.id}`,
      }),
      new CodexBackend(config, { executable: process.execPath, args: [codexScript], label: "Codex" }),
    ],
    config,
  );

  const server = createProxyServer({ config, router });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as AnthropicModelsListResponse;
    // 1 agy1 + 1 agy2 + 2 opencode (go + free; paid filtered out!) + 1 grok + 1 codex = 6
    assert.equal(modelsJson.data.length, 6);
    for (const missing of [
      "claude-fable-acp-agy-a3f9ab07.g--emini-4-hydrogen[1m]",
      "agy-missing.gemini-4-hydrogen",
      "unknown-model",
    ]) {
      assert.throws(() => router.resolveTarget(missing), /unavailable/i);
    }
    for (const m of modelsJson.data) {
      assert.equal(isClaudeDesktopCompatibleId(m.id), true);
      assert.equal(m.id.includes("-h-"), false, `Expected readable gateway ID, got ${m.id}`);
      assert.equal(m.max_effort_level, "max");
      assert.ok(m.description);
    }
    assert.equal(new Set(modelsJson.data.map((m) => m.display_name)).size, modelsJson.data.length);

    const agy2Model = modelsJson.data.find((m) => m.description === "Antigravity 2: gemini-4-hydrogen");
    const ocGoModel = modelsJson.data.find((m) => m.description === "OpenCode Go: kimi-k3.1-pro");
    const ocFreeModel = modelsJson.data.find((m) => m.description === "OpenCode: beam-free");
    const grokModel = modelsJson.data.find((m) => m.description === "Grok: grok-4.7");
    const codexModel = modelsJson.data.find((m) => m.description === "ChatGPT: gpt-6-luna");
    assert.ok(agy2Model && ocGoModel && ocFreeModel && grokModel && codexModel);

    // Antigravity Account 2
    const agy2Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: agy2Model.id, output_config: { effort: "high" }, messages: [{ role: "user", content: "ping agy2" }] }),
    });
    const agy2Json = (await agy2Res.json()) as { content: Array<{ text?: string }> };
    assert.match(agy2Json.content[0]?.text ?? "", /^agy2:gemini-4-hydrogen:thought_level=high:ping agy2$/);

    // OpenCode Go with xhigh -> wire value "extra"
    const ocRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ocGoModel.id, output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "ping oc" }] }),
    });
    const ocJson = (await ocRes.json()) as { content: Array<{ text?: string }> };
    assert.match(ocJson.content[0]?.text ?? "", /^oc:opencode-go\/kimi-k3\.1-pro:effort=extra:ping oc$/);

    // Grok ACP with reasoning_effort
    const grokRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: grokModel.id, output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "ping grok" }] }),
    });
    const grokJson = (await grokRes.json()) as { content: Array<{ text?: string }> };
    assert.match(grokJson.content[0]?.text ?? "", /^grok:grok-4\.7:reasoning_effort=xhigh:ping grok$/);

    // Codex app-server
    const codexRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: codexModel.id, output_config: { effort: "high" }, messages: [{ role: "user", content: "ping codex" }] }),
    });
    const codexJson = (await codexRes.json()) as { content: Array<{ type: string; text?: string; thinking?: string }> };
    const codexThinking = codexJson.content.find((c) => c.type === "thinking")?.thinking ?? "";
    assert.match(codexThinking, /^Codex thinking\.\.\./);
    assert.match(codexThinking, /\[Codex tool\] Run npm test\.\.\./);
    assert.match(codexThinking, /\[Codex tool completed\] Run npm test/);
    assert.match(codexThinking, /output: tests passed/);
    assert.match(codexThinking, /\[Codex tool progress\] loading schema/);
    assert.match(codexJson.content.find((c) => c.type === "text")?.text ?? "", /^thr-1:gpt-6-luna:effort=high:ping codex$/);

    // OpenAI /openai/v1/models
    const oaiModelsRes = await fetch(`${baseUrl}/openai/v1/models`);
    assert.equal(oaiModelsRes.status, 200);
    const oaiModelsJson = (await oaiModelsRes.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
    assert.equal(oaiModelsJson.object, "list");
    assert.equal(oaiModelsJson.data.length, 6);
    assert.ok(oaiModelsJson.data.some((m) => m.id === "codex.gpt-6-luna" && m.owned_by === "codex"));

    // OpenAI POST /v1/chat/completions (non-stream + stream)
    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok.grok-4.7",
        reasoning_effort: "high",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "ping oai chat" },
        ],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    assert.equal(chatJson.object, "chat.completion");
    assert.equal(chatJson.choices[0]?.finish_reason, "stop");
    assert.match(chatJson.choices[0]?.message.content ?? "", /grok:grok-4\.7:reasoning_effort=high:[\s\S]*Be brief\.[\s\S]*ping oai chat$/);
    assert.ok(chatJson.usage.total_tokens > 0);

    const chatStreamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "agy-acc1.gemini-4-hydrogen",
        stream: true,
        messages: [{ role: "user", content: "stream oai chat" }],
      }),
    });
    assert.equal(chatStreamRes.status, 200);
    const chatStreamText = await chatStreamRes.text();
    assert.match(chatStreamText, /"object":"chat\.completion\.chunk"/);
    assert.match(chatStreamText, /agy1:gemini-4-hydrogen/);
    assert.match(chatStreamText, /data: \[DONE\]/);

    // OpenAI POST /v1/responses (Codex Responses API, non-stream + stream)
    const respRes = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex.gpt-6-luna",
        instructions: "Act as helper.",
        reasoning: { effort: "medium" },
        input: "ping responses",
      }),
    });
    assert.equal(respRes.status, 200);
    const respJson = (await respRes.json()) as { object: string; status: string; output_text: string };
    assert.equal(respJson.object, "response");
    assert.equal(respJson.status, "completed");
    assert.match(respJson.output_text, /^thr-\d+:gpt-6-luna:effort=medium:ping responses$/);

    const respStreamRes = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex.gpt-6-luna",
        stream: true,
        input: [{ type: "message", role: "user", content: "stream responses" }],
      }),
    });
    assert.equal(respStreamRes.status, 200);
    const respStreamText = await respStreamRes.text();
    assert.match(respStreamText, /event: response\.created/);
    assert.match(respStreamText, /event: response\.output_text\.delta/);
    assert.match(respStreamText, /event: response\.completed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await router.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Additional OpenBot ACP backends (Copilot, Custom ACP) route via prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extra-acp-test-"));
  const copilotScript = createFakeProviderAcpScript(dir, "fake-copilot.mjs", {
    thoughtId: "effort",
    thoughtValues: ["low", "medium", "high"],
    models: [{ value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
    tag: "copilot",
  });
  const customScript = createFakeProviderAcpScript(dir, "fake-custom.mjs", {
    thoughtId: "thought_level",
    thoughtValues: ["low", "high"],
    models: [{ value: "my-local-model", name: "My Local Model" }],
    tag: "myacp",
  });

  const config: ProxyConfig = {
    help: false,
    host: "127.0.0.1",
    port: 0,
    devinPath: process.execPath,
    cwd: dir,
    mode: "bypass",
    defaultModel: "claude-sonnet-4.5",
    thoughtLevel: null,
    speed: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: null,
    modelMap: {},
    gatewayAliases: true,
    requestTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    idleSessionTtlMs: 60_000,
    maxSessions: 4,
    debug: false,
  };

  const copilotAcp = new AcpClient(config, { label: "Copilot", executable: process.execPath, args: [copilotScript], supportsCloseSession: false });
  const customAcp = new AcpClient(config, { label: "MyACP", executable: process.execPath, args: [customScript], supportsCloseSession: false });

  const router = new BackendRouter(
    [
      new AcpProxyBackend({
        key: "copilot",
        kind: "copilot",
        label: "Copilot",
        acp: copilotAcp,
        sessions: new SessionManager(copilotAcp, config, { backendKind: "copilot", backendLabel: "Copilot" }),
        qualifiedPrefix: "copilot.",
      }),
      new AcpProxyBackend({
        key: "acp-local",
        kind: "custom",
        label: "MyACP",
        acp: customAcp,
        sessions: new SessionManager(customAcp, config, { backendKind: "custom", backendLabel: "MyACP" }),
        qualifiedPrefix: "acp-local.",
      }),
    ],
    config,
  );

  const server = createProxyServer({ config, router, forceOpenAI: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as { object: string; data: Array<{ id: string }> };
    assert.equal(modelsJson.object, "list");
    assert.deepEqual(
      modelsJson.data.map((m) => m.id),
      ["copilot.claude-sonnet-4.5", "acp-local.my-local-model"],
    );

    const r1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "acp-local.my-local-model-high",
        messages: [{ role: "user", content: "hello custom" }],
      }),
    });
    const j1 = (await r1.json()) as { choices: Array<{ message: { content: string } }> };
    assert.match(j1.choices[0]?.message.content ?? "", /^myacp:my-local-model:thought_level=high:hello custom$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await router.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP prompt timeout counts silence, not total turn duration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-idle-"));
  const scriptPath = join(dir, "slow-acp.mjs");
  writeFileSync(
    scriptPath,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (o) => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10));
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/prompt") {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tick " + ticks } } } });
      if (ticks === 8) {
        clearInterval(timer);
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 8 } } });
      }
    }, 100);
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`,
  );

  const config: ProxyConfig = {
    help: false,
    host: "127.0.0.1",
    port: 0,
    devinPath: process.execPath,
    acpArgs: [scriptPath],
    cwd: dir,
    mode: "bypass",
    defaultModel: "swe-2-1-medium",
    thoughtLevel: null,
    speed: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: "secret-key",
    modelMap: {},
    gatewayAliases: true,
    requestTimeoutMs: 350,
    startupTimeoutMs: 10_000,
    idleSessionTtlMs: 60_000,
    maxSessions: 4,
    debug: false,
  };

  const acp = new AcpClient(config, {
    label: "Slow",
    executable: process.execPath,
    args: [scriptPath],
    supportsCloseSession: false,
  });

  try {
    const res = await acp.prompt("sess-slow", [{ type: "text", text: "hi" }]);
    assert.equal(res.stopReason, "end_turn");
    assert.equal(res.usage?.outputTokens, 8);
  } finally {
    await acp.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForCancelFrames(path: string, timeoutMs = 2_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) {
        return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    } catch {
      // File is created by the fake agent only after cancellation arrives.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("ACP cancellation frame was not written before the deadline");
}

test("streaming client disconnect sends ACP session/cancel as a notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-cancel-probe-"));
  const scriptPath = join(dir, "cancel-probe-acp.mjs");
  const cancelLogPath = join(dir, "cancel-frames.jsonl");
  writeFileSync(
    scriptPath,
    `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const cancelLog = process.env.CANCEL_LOG;
const pendingPrompts = new Map();
let nextSess = 1;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    const sid = "cancel-s" + nextSess++;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: sid,
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "hang-model", options: [{ value: "hang-model", name: "Hang Model" }] },
          { id: "thought_level", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "medium", name: "medium" }] }
        ]
      }
    });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    return;
  }
  if (msg.method === "session/prompt") {
    pendingPrompts.set(msg.params.sessionId, msg.id);
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } } } });
    return;
  }
  if (msg.method === "session/cancel") {
    appendFileSync(cancelLog, JSON.stringify(msg) + "\\n");
    if (msg.id === undefined) {
      const promptId = pendingPrompts.get(msg.params.sessionId);
      if (promptId !== undefined) {
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 1 } } });
      }
    }
    return;
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`,
  );

  const config: ProxyConfig = {
    help: false,
    host: "127.0.0.1",
    port: 0,
    devinPath: process.execPath,
    acpArgs: [scriptPath],
    cwd: dir,
    mode: "bypass",
    defaultModel: "hang-model",
    thoughtLevel: null,
    speed: null,
    showTools: "thinking",
    processModel: "in-process",
    apiKey: "secret-key",
    modelMap: {},
    gatewayAliases: true,
    requestTimeoutMs: 5_000,
    startupTimeoutMs: 5_000,
    idleSessionTtlMs: 60_000,
    maxSessions: 4,
    debug: false,
  };

  const acp = new AcpClient(config, {
    label: "CancelProbe",
    executable: process.execPath,
    args: [scriptPath],
    env: { CANCEL_LOG: cancelLogPath },
    supportsCloseSession: false,
  });
  const sessions = new SessionManager(acp, config);
  const server = createProxyServer({ config, acp, sessions });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const clientAbort = new AbortController();

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hang-model",
        stream: true,
        messages: [{ role: "user", content: "hang until cancelled" }],
      }),
      signal: clientAbort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    const startedDeadline = Date.now() + 2_000;
    while (!wire.includes("started")) {
      if (Date.now() > startedDeadline) {
        throw new Error("fake ACP turn did not start streaming");
      }
      const next = await reader.read();
      if (next.done) break;
      wire += decoder.decode(next.value, { stream: true });
    }

    const pendingRead = reader.read();
    clientAbort.abort();
    await pendingRead.catch(() => undefined);
    const frames = await waitForCancelFrames(cancelLogPath);
    assert.equal(frames[0]?.method, "session/cancel");
    assert.equal(
      Object.hasOwn(frames[0] ?? {}, "id"),
      false,
      "session/cancel must be a JSON-RPC notification, not a request",
    );
  } finally {
    clientAbort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sessions.closeAll();
    await acp.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
