import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read file", status: "completed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sid + "#" + state.turns + " model=" + state.model + " mode=" + state.mode + " thought=" + state.thought + " speed=" + state.speed + " prompt=" + text } } } });
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
