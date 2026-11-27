#!/usr/bin/env node
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.js";
import { CodexBackend } from "./codex-client.js";
import { helpText, loadConfig } from "./config.js";
import { filterOpencodeModels, isFreeOpencodeModel } from "./models.js";
import { BackendRouter } from "./router.js";
import { createProxyServer } from "./server.js";
import { AcpProxyBackend, SessionManager } from "./sessions.js";
import type { DevinModelEntry, ProxyBackend, ProxyConfig } from "./types.js";

function formatOpenCodeQualifiedId(model: DevinModelEntry): string {
  const lower = model.id.toLowerCase();
  if (lower.startsWith("opencode-go/")) {
    return `oc-go.${model.id.slice("opencode-go/".length)}`;
  }
  if (lower.startsWith("opencode/")) {
    return `oc-free.${model.id.slice("opencode/".length)}`;
  }
  return `oc.${model.id}`;
}

function formatOpenCodeDescription(model: DevinModelEntry): string {
  const lower = model.id.toLowerCase();
  if (lower.startsWith("opencode-go/")) {
    return `OpenCode Go: ${model.id.replace(/^opencode-go\//i, "")}`.slice(0, 100);
  }
  if (lower.startsWith("opencode/")) {
    return `OpenCode: ${model.id.replace(/^opencode\//i, "")}`.slice(0, 100);
  }
  return `OpenCode: ${model.id}`.slice(0, 100);
}

export function buildBackends(config: ProxyConfig): ProxyBackend[] {
  const backends: ProxyBackend[] = [];

  if (config.enableDevin !== false) {
    const devinAcp = new AcpClient(config, {
      label: "Devin",
      executable: config.devinPath,
      args: config.acpArgs ?? ["acp", "--process-model", config.processModel],
      supportsCloseSession: true,
      closeForceMeta: true,
    });
    const devinSessions = new SessionManager(devinAcp, config, {
      backendKind: "devin",
      backendLabel: "Devin",
    });
    backends.push(
      new AcpProxyBackend({
        key: "devin",
        kind: "devin",
        label: "Devin",
        acp: devinAcp,
        sessions: devinSessions,
        qualifiedPrefix: "",
        formatDescription: (m) => `Devin: ${m.id}`.slice(0, 100),
      }),
    );
  }

  if (config.enableAntigravity && config.antigravityPath) {
    const accounts = config.antigravityAccounts ?? [];
    for (let i = 0; i < accounts.length; i += 1) {
      const acc = accounts[i]!;
      const accountNum = i + 1;
      const label = `Antigravity ${accountNum} (${acc.label})`;
      const agyAcp = new AcpClient(config, {
        label,
        executable: config.antigravityPath,
        args: ["acp", `--gemini-dir=${acc.geminiDir}`, `--app-data-dir=${acc.appDataDir}`],
        env: {
          WSL_DISTRO_NAME: "OpenBot",
          ANTIGRAVITY_CLI_NO_AUTO_UPDATE: "1",
          ANTIGRAVITY_AGENT: undefined,
          ANTIGRAVITY_AGENTAPI_EXE: undefined,
          ANTIGRAVITY_APP_DATA_DIR: undefined,
          ANTIGRAVITY_CONVERSATION_ID: undefined,
          ANTIGRAVITY_CSRF_TOKEN: undefined,
          ANTIGRAVITY_LS_ADDRESS: undefined,
          ANTIGRAVITY_LS_VERSION: undefined,
          ANTIGRAVITY_SOURCE_METADATA: undefined,
          ANTIGRAVITY_TRAJECTORY_ID: undefined,
          GEMINI_HOME: undefined,
        },
        supportsCloseSession: false,
        closeForceMeta: false,
      });
      const agySessions = new SessionManager(agyAcp, config, {
        backendKind: "antigravity",
        backendLabel: label,
      });
      backends.push(
        new AcpProxyBackend({
          key: `antigravity:${acc.id}`,
          kind: "antigravity",
          label,
          acp: agyAcp,
          sessions: agySessions,
          qualifiedPrefix: `agy-${acc.id}.`,
          formatDisplayName: (m) => m.name,
          formatDescription: (m) => `Antigravity ${accountNum}: ${m.id}`.slice(0, 100),
        }),
      );
    }
  }

  if (config.enableOpencode && config.opencodePath) {
    const ocAcp = new AcpClient(config, {
      label: "OpenCode",
      executable: config.opencodePath,
      args: ["acp"],
      env: {
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      supportsCloseSession: false,
      closeForceMeta: false,
    });
    const ocFilter = config.opencodeFilter ?? "go-free";
    const ocProviders = config.opencodeProviders ?? [];
    const ocSessions = new SessionManager(ocAcp, config, {
      backendKind: "opencode",
      backendLabel: "OpenCode",
      filterModels: (models) => filterOpencodeModels(models, ocFilter, ocProviders),
    });
    backends.push(
      new AcpProxyBackend({
        key: "opencode",
        kind: "opencode",
        label: "OpenCode",
        acp: ocAcp,
        sessions: ocSessions,
        qualifiedPrefix: "oc.",
        formatQualifiedId: formatOpenCodeQualifiedId,
        formatDisplayName: (m) => m.name.replace(/^(?:opencode-go|opencode)\//i, "").trim(),
        formatDescription: formatOpenCodeDescription,
      }),
    );
  }

  if (config.enableGrok && config.grokPath) {
    const xaiKey = config.xaiApiKey ?? process.env.XAI_API_KEY?.trim();
    const grokAuthMethods = xaiKey ? ["xai.api_key", "cached_token"] : ["cached_token"];
    const grokAcp = new AcpClient(config, {
      label: "Grok",
      executable: config.grokPath,
      args: [
        "--no-auto-update",
        "--permission-mode",
        config.mode === "ask" ? "default" : "bypassPermissions",
        "agent",
        "stdio",
      ],
      env: {
        GROK_OAUTH2_REFERRER: "openbot",
        ...(xaiKey ? { XAI_API_KEY: xaiKey } : {}),
      },
      authMethodIds: grokAuthMethods,
      supportsCloseSession: false,
      closeForceMeta: false,
    });
    const grokSessions = new SessionManager(grokAcp, config, {
      backendKind: "grok",
      backendLabel: "Grok",
    });
    backends.push(
      new AcpProxyBackend({
        key: "grok",
        kind: "grok",
        label: "Grok",
        acp: grokAcp,
        sessions: grokSessions,
        qualifiedPrefix: "grok.",
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `Grok: ${m.id}`.slice(0, 100),
      }),
    );
  }

  if (config.enableCodex && config.codexPath) {
    backends.push(
      new CodexBackend(config, {
        executable: config.codexPath,
        label: "Codex",
      }),
    );
  }

  const extraAcpBackends: Array<{
    enabled?: boolean;
    path?: string;
    key: string;
    kind: "copilot" | "cursor" | "cline" | "mistral" | "kimi" | "hermes";
    label: string;
    args: string[];
    env?: Record<string, string | undefined>;
    authMethodIds?: string[];
    descPrefix: string;
  }> = [
    {
      enabled: config.enableCopilot,
      path: config.copilotPath,
      key: "copilot",
      kind: "copilot",
      label: "Copilot",
      args: ["--acp", "--no-auto-update"],
      descPrefix: "GitHub Copilot",
    },
    {
      enabled: config.enableCursor,
      path: config.cursorPath,
      key: "cursor",
      kind: "cursor",
      label: "Cursor",
      args: ["acp"],
      descPrefix: "Cursor",
    },
    {
      enabled: config.enableCline,
      path: config.clinePath,
      key: "cline",
      kind: "cline",
      label: "Cline",
      args: ["--acp"],
      env: { CLINE_SESSION_BACKEND_MODE: "local", CLINE_NO_AUTO_UPDATE: "1" },
      authMethodIds: ["cline"],
      descPrefix: "Cline",
    },
    {
      enabled: config.enableMistral,
      path: config.mistralPath,
      key: "mistral",
      kind: "mistral",
      label: "Mistral Vibe",
      args: [],
      env: { VIBE_ENABLE_TELEMETRY: "false", VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG: "true" },
      authMethodIds: ["browser-auth"],
      descPrefix: "Mistral",
    },
    {
      enabled: config.enableKimi,
      path: config.kimiPath,
      key: "kimi",
      kind: "kimi",
      label: "Kimi",
      args: ["acp"],
      env: { KIMI_CLI_NO_AUTO_UPDATE: "1" },
      descPrefix: "Kimi",
    },
    {
      enabled: config.enableHermes,
      path: config.hermesPath,
      key: "hermes",
      kind: "hermes",
      label: "Hermes",
      args: ["acp"],
      descPrefix: "Hermes",
    },
  ];

  for (const spec of extraAcpBackends) {
    if (!spec.enabled || !spec.path) continue;
    const acp = new AcpClient(config, {
      label: spec.label,
      executable: spec.path,
      args: spec.args,
      env: spec.env,
      authMethodIds: spec.authMethodIds,
      supportsCloseSession: false,
      closeForceMeta: false,
    });
    const sessions = new SessionManager(acp, config, {
      backendKind: spec.kind,
      backendLabel: spec.label,
    });
    backends.push(
      new AcpProxyBackend({
        key: spec.key,
        kind: spec.kind,
        label: spec.label,
        acp,
        sessions,
        qualifiedPrefix: `${spec.key}.`,
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `${spec.descPrefix}: ${m.id}`.slice(0, 100),
      }),
    );
  }

  for (const custom of config.customAcpAgents ?? []) {
    if (custom.enabled === false || !custom.command.trim()) continue;
    const label = custom.name || custom.id;
    const acp = new AcpClient(config, {
      label,
      executable: custom.command,
      args: custom.args ?? [],
      env: custom.env,
      authMethodIds: custom.authMethodId ? [custom.authMethodId] : undefined,
      supportsCloseSession: false,
      closeForceMeta: false,
    });
    const sessions = new SessionManager(acp, config, {
      backendKind: "custom",
      backendLabel: label,
    });
    backends.push(
      new AcpProxyBackend({
        key: `acp-${custom.id}`,
        kind: "custom",
        label,
        acp,
        sessions,
        qualifiedPrefix: `acp-${custom.id}.`,
        formatDisplayName: (m) => m.name,
        formatDescription: (m) => `${label}: ${m.id}`.slice(0, 100),
      }),
    );
  }

  return backends;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.help) {
    process.stdout.write(helpText());
    return;
  }

  const backends = buildBackends(config);
  const router = new BackendRouter(backends, config);
  const server = createProxyServer({ config, router });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const bound = server.address() as AddressInfo | null;
  const port = bound?.port ?? config.port;
  const baseUrl = `http://${config.host}:${port}`;

  let openaiServer: ReturnType<typeof createProxyServer> | null = null;
  let openaiBaseUrl = `${baseUrl}/openai/v1`;
  if (config.enableOpenai !== false && config.openaiPort && config.openaiPort !== port) {
    openaiServer = createProxyServer({ config, router, forceOpenAI: true });
    await new Promise<void>((resolve, reject) => {
      openaiServer!.once("error", reject);
      openaiServer!.listen(config.openaiPort!, config.host, () => {
        openaiServer!.off("error", reject);
        resolve();
      });
    });
    const ob = openaiServer.address() as AddressInfo | null;
    openaiBaseUrl = `http://${config.host}:${ob?.port ?? config.openaiPort}/v1`;
  }

  console.log(`AI Proxy listening on ${baseUrl}`);
  if (config.enableOpenai !== false) {
    console.log(`OpenAI / Codex gateway: ${openaiBaseUrl}`);
  }
  console.log(`Workspace CWD: ${config.cwd} (mode: ${config.mode})`);
  console.log(`Enabled backends (${backends.length}): ${backends.map((b) => b.label).join(", ") || "none"}`);

  try {
    const models = await router.warmUp();
    for (const status of router.getHealthStatuses()) {
      if (status.error) {
        console.warn(`  [warn] ${status.label}: ${status.error}`);
      } else {
        console.log(`  [ready] ${status.label}: ${status.modelsCount} models`);
      }
    }
    console.log(`Total exposed models: ${models.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning during warmup (will retry on first request): ${message}`);
  }

  console.log(`\nClaude Desktop (Developer Mode -> Configure Third-Party Inference):`);
  console.log(`  Provider: Gateway`);
  console.log(`  Gateway Base URL: ${baseUrl}`);
  console.log(`  API Key: any string (or your PROXY_API_KEY)`);
  console.log(`\nClaude Code (~/.claude/settings.json or shell env):`);
  console.log(`  ANTHROPIC_BASE_URL=${baseUrl}`);
  console.log(`  ANTHROPIC_AUTH_TOKEN=local-proxy`);
  if (config.enableOpenai !== false) {
    console.log(`\nOpenAI / Codex CLI:`);
    console.log(`  OPENAI_BASE_URL=${openaiBaseUrl}`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (openaiServer) {
      await new Promise<void>((resolve) => openaiServer!.close(() => resolve()));
    }
    await router.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
