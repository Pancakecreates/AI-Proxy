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
    const grokAuthMethods = process.env.XAI_API_KEY?.trim()
      ? ["xai.api_key", "cached_token"]
      : ["cached_token"];
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

  console.log(`AI-Anthropic-Proxy listening on ${baseUrl}`);
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
  console.log(`  ANTHROPIC_AUTH_TOKEN=devin-local`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
