import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type {
  AntigravityAccountConfig,
  CustomAcpAgentConfig,
  DevinMode,
  OpenCodeFilterMode,
  ProcessModel,
  ProxyConfig,
  ShowToolsMode,
  SpeedMode,
  ThoughtLevel,
} from "./types.js";

const VALID_MODES = new Set<DevinMode>(["bypass", "accept-edits", "smart", "ask", "plan"]);
const VALID_THOUGHT_LEVELS = new Set<ThoughtLevel>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const VALID_SPEEDS = new Set<SpeedMode>(["standard", "fast", "ultrafast"]);
const VALID_SHOW_TOOLS = new Set<ShowToolsMode>(["thinking", "text", "none"]);
const VALID_PROCESS_MODELS = new Set<ProcessModel>(["in-process", "daemon"]);
const VALID_OPENCODE_FILTERS = new Set<OpenCodeFilterMode>(["go-free", "all", "custom"]);

function openBotAppDataDir(): string {
  return (
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".config"))
  );
}

function openBotPlatformDir(): string {
  return process.platform === "win32"
    ? "win32-x64"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";
}

function resolveOpenBotRuntimeExecutable(
  runtimeName: string,
  baseExeNames: string | readonly string[],
  explicitCandidates: Array<string | undefined>,
): string | undefined {
  const names = Array.isArray(baseExeNames) ? baseExeNames : [baseExeNames];

  for (const candidate of explicitCandidates) {
    if (candidate && candidate.trim() && existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  const exeVariants = (base: string) =>
    process.platform === "win32" ? [`${base}.exe`, `${base}.cmd`, base] : [base];

  const runtimeRoot = join(openBotAppDataDir(), "OpenBot", "provider-runtimes", runtimeName, openBotPlatformDir());
  if (existsSync(runtimeRoot)) {
    const versions = readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      for (const base of names) {
        for (const exeName of exeVariants(base)) {
          const candidate = join(runtimeRoot, version, "bin", exeName);
          if (existsSync(candidate)) return resolve(candidate);
        }
      }
    }
  }

  const pathDirs = (process.env.PATH ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const base of names) {
      for (const exeName of exeVariants(base)) {
        const candidate = join(dir, exeName);
        if (existsSync(candidate)) return resolve(candidate);
      }
    }
  }

  return undefined;
}

/**
 * Resolve the Devin CLI executable path automatically from env, OpenBot runtime cache, or PATH.
 */
export function resolveDevinExecutable(explicitPath?: string): string {
  const exeName = process.platform === "win32" ? "devin.exe" : "devin";
  return (
    resolveOpenBotRuntimeExecutable("devin", "devin", [
      explicitPath,
      process.env.DEVIN_PATH,
      process.env.OPENBOT_DEVIN_PATH,
    ]) ?? exeName
  );
}

/**
 * Resolve the Antigravity (Gemini) CLI executable path from env, OpenBot runtime cache, or PATH.
 */
export function resolveAntigravityExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("antigravity", "antigravity", [
    explicitPath,
    process.env.ANTIGRAVITY_PATH,
    process.env.OPENBOT_ANTIGRAVITY_PATH,
  ]);
}

export function resolveOpencodeExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("opencode", "opencode", [
    explicitPath,
    process.env.OPENCODE_PATH,
    process.env.OPENBOT_OPENCODE_PATH,
  ]);
}

export function resolveGrokExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("grok", "grok", [
    explicitPath,
    process.env.GROK_PATH,
    process.env.OPENBOT_GROK_PATH,
  ]);
}

export function resolveCodexExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("codex", "codex", [
    explicitPath,
    process.env.CODEX_PATH,
    process.env.OPENBOT_CODEX_PATH,
  ]);
}

export function resolveCopilotExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("copilot", "copilot", [
    explicitPath,
    process.env.COPILOT_PATH,
    process.env.OPENBOT_COPILOT_PATH,
  ]);
}

export function resolveCursorExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("cursor", ["cursor-agent", "agent"], [
    explicitPath,
    process.env.CURSOR_PATH,
    process.env.OPENBOT_CURSOR_PATH,
  ]);
}

export function resolveClineExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("cline", "cline", [
    explicitPath,
    process.env.CLINE_PATH,
    process.env.OPENBOT_CLINE_PATH,
  ]);
}

export function resolveMistralExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("mistral", ["vibe-acp", "vibe"], [
    explicitPath,
    process.env.MISTRAL_PATH,
    process.env.OPENBOT_MISTRAL_PATH,
  ]);
}

export function resolveKimiExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("kimi", "kimi", [
    explicitPath,
    process.env.KIMI_PATH,
    process.env.OPENBOT_KIMI_PATH,
  ]);
}

export function resolveHermesExecutable(explicitPath?: string): string | undefined {
  return resolveOpenBotRuntimeExecutable("hermes", "hermes", [
    explicitPath,
    process.env.HERMES_PATH,
    process.env.OPENBOT_HERMES_PATH,
  ]);
}

/**
 * Safely read ONLY the non-secret email label from an Antigravity token file.
 */
function readAntigravityAccountEmail(appDataPath: string): string | undefined {
  const tokenFile = join(appDataPath, "antigravity-oauth-token");
  if (!existsSync(tokenFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(tokenFile, "utf8")) as { id_token_email?: unknown };
    if (typeof parsed?.id_token_email === "string" && parsed.id_token_email.trim()) {
      return parsed.id_token_email.trim();
    }
  } catch {
    // Ignore malformed or unreadable file
  }
  return undefined;
}

function makeShortAccountId(dirName: string, usedIds: Set<string>, fallbackIndex: number): string {
  const base = dirName.replace(/[^a-z0-9_-]/gi, "").slice(0, 8) || `acc${fallbackIndex}`;
  let id = base;
  let n = 2;
  while (usedIds.has(id)) {
    id = `${base}-${n++}`;
  }
  usedIds.add(id);
  return id;
}

/**
 * Discover Antigravity (Gemini) accounts from ANTIGRAVITY_ACCOUNTS, ANTIGRAVITY_GEMINI_DIR,
 * or OpenBot's `%APPDATA%/OpenBot/provider-accounts/*`.
 */
export function discoverAntigravityAccounts(options: {
  explicitGeminiDir?: string;
  explicitAppDataDir?: string;
  explicitAccountsEnv?: string;
} = {}): AntigravityAccountConfig[] {
  const defaultAppData =
    options.explicitAppDataDir && !options.explicitAppDataDir.includes("\\") && !options.explicitAppDataDir.includes("/")
      ? options.explicitAppDataDir
      : "antigravity-acp";
  const usedIds = new Set<string>();

  const rawAccounts = options.explicitAccountsEnv?.trim();
  if (rawAccounts) {
    if (rawAccounts.startsWith("[")) {
      try {
        const parsed = JSON.parse(rawAccounts) as Array<Partial<AntigravityAccountConfig>>;
        const out: AntigravityAccountConfig[] = [];
        for (let i = 0; i < parsed.length; i += 1) {
          const item = parsed[i];
          if (!item || typeof item.geminiDir !== "string" || !item.geminiDir.trim()) continue;
          const geminiDir = resolve(item.geminiDir.trim());
          const appDataDir = item.appDataDir?.trim() || defaultAppData;
          const email = item.email?.trim() || readAntigravityAccountEmail(join(geminiDir, appDataDir));
          const id = item.id?.trim() || makeShortAccountId(`acc${i + 1}`, usedIds, i + 1);
          usedIds.add(id);
          out.push({
            id,
            label: item.label?.trim() || email || `Account ${i + 1}`,
            geminiDir,
            appDataDir,
            ...(email ? { email } : {}),
          });
        }
        if (out.length > 0) return out;
      } catch {
        // Fallback to comma-separated parsing
      }
    }

    const parts = rawAccounts
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: AntigravityAccountConfig[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const eq = part.indexOf("=");
      const customLabel = eq > 0 && !part.slice(0, eq).includes(":") ? part.slice(0, eq).trim() : undefined;
      const geminiDir = resolve(customLabel ? part.slice(eq + 1).trim() : part);
      const email = readAntigravityAccountEmail(join(geminiDir, defaultAppData));
      const id = makeShortAccountId(customLabel || `acc${i + 1}`, usedIds, i + 1);
      out.push({
        id,
        label: customLabel || email || `Account ${i + 1}`,
        geminiDir,
        appDataDir: defaultAppData,
        ...(email ? { email } : {}),
      });
    }
    if (out.length > 0) return out;
  }

  if (options.explicitGeminiDir) {
    const geminiDir = resolve(options.explicitGeminiDir);
    const email = readAntigravityAccountEmail(join(geminiDir, defaultAppData));
    return [
      {
        id: "main",
        label: email || "Account 1",
        geminiDir,
        appDataDir: defaultAppData,
        ...(email ? { email } : {}),
      },
    ];
  }

  const discovered: AntigravityAccountConfig[] = [];
  const seenDirs = new Set<string>();

  const pushAccount = (geminiDirRaw: string, preferredId: string): void => {
    const geminiDir = resolve(geminiDirRaw);
    if (seenDirs.has(geminiDir.toLowerCase())) return;
    const appDataPath = join(geminiDir, defaultAppData);
    if (!existsSync(appDataPath)) return;
    seenDirs.add(geminiDir.toLowerCase());
    const email = readAntigravityAccountEmail(appDataPath);
    const id = makeShortAccountId(preferredId, usedIds, discovered.length + 1);
    discovered.push({
      id,
      label: email || `Account ${discovered.length + 1} (${id})`,
      geminiDir,
      appDataDir: defaultAppData,
      ...(email ? { email } : {}),
    });
  };

  // Primary OpenBot / Antigravity home (~/.gemini/antigravity-acp)
  pushAccount(join(homedir(), ".gemini"), "primary");

  // Additional OpenBot accounts (%APPDATA%/OpenBot/provider-accounts/*/antigravity-acp)
  const accountsRoot = join(openBotAppDataDir(), "OpenBot", "provider-accounts");
  if (existsSync(accountsRoot)) {
    const entries = readdirSync(accountsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    for (const dirName of entries) {
      pushAccount(join(accountsRoot, dirName), dirName);
    }
  }
  return discovered;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const norm = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(norm)) return true;
  if (["0", "false", "no", "off"].includes(norm)) return false;
  return fallback;
}

function parseJsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseCliArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token.startsWith("--no-")) {
      args[token.slice(5)] = "false";
      continue;
    }
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value: string;
    const nextToken = argv[i + 1];
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else if (nextToken !== undefined && !nextToken.startsWith("--")) {
      value = nextToken;
      i += 1;
    } else {
      value = "true";
    }
    args[key] = value;
  }
  return args;
}

function loadDotEnvIfPresent(): void {
  const envFile = resolve(process.cwd(), ".env");
  const nodeProcess = process as typeof process & { loadEnvFile?: (path?: string) => void };
  if (!existsSync(envFile) || typeof nodeProcess.loadEnvFile !== "function") return;
  try {
    nodeProcess.loadEnvFile(envFile);
  } catch {
    // Ignore malformed optional .env
  }
}

function cliString(cli: Record<string, string | boolean>, key: string): string | undefined {
  const v = cli[key];
  return typeof v === "string" ? v : undefined;
}

function parseCustomAcpAgents(raw: string | undefined): CustomAcpAgentConfig[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomAcpAgentConfig[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const command = typeof rec.command === "string" ? rec.command.trim() : "";
      if (!command) continue;
      const rawId = typeof rec.id === "string" ? rec.id.trim() : `custom-${i + 1}`;
      const id = rawId.replace(/[^a-z0-9_-]/gi, "-") || `custom-${i + 1}`;
      const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
      const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : [];
      const env: Record<string, string> = {};
      if (rec.env && typeof rec.env === "object" && !Array.isArray(rec.env)) {
        for (const [k, v] of Object.entries(rec.env)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      out.push({
        id,
        name,
        command,
        args,
        env,
        cwd: typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : undefined,
        authMethodId: typeof rec.authMethodId === "string" && rec.authMethodId.trim() ? rec.authMethodId.trim() : undefined,
        enabled: rec.enabled !== false,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2)): ProxyConfig {
  loadDotEnvIfPresent();
  const cli = parseCliArgs(argv);

  const mode = (cliString(cli, "mode") ?? process.env.DEVIN_MODE ?? "bypass").trim() as DevinMode;
  const thoughtLevelRaw = (cliString(cli, "thought-level") ?? process.env.DEVIN_THOUGHT_LEVEL ?? "").trim().toLowerCase();
  const thoughtLevel = (thoughtLevelRaw || null) as ThoughtLevel | null;
  const speedRaw = (cliString(cli, "speed") ?? process.env.DEVIN_SPEED ?? "").trim().toLowerCase();
  const speed = (speedRaw || null) as SpeedMode | null;
  const showTools = (cliString(cli, "show-tools") ?? process.env.DEVIN_SHOW_TOOLS ?? "thinking").trim() as ShowToolsMode;
  const processModel = (cliString(cli, "process-model") ?? process.env.DEVIN_PROCESS_MODEL ?? "in-process").trim() as ProcessModel;

  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid DEVIN_MODE "${mode}". Expected one of: ${[...VALID_MODES].join(", ")}`);
  }
  if (thoughtLevel && !VALID_THOUGHT_LEVELS.has(thoughtLevel)) {
    throw new Error(
      `Invalid DEVIN_THOUGHT_LEVEL "${thoughtLevel}". Expected one of: ${[...VALID_THOUGHT_LEVELS].join(", ")}`,
    );
  }
  if (speed && !VALID_SPEEDS.has(speed)) {
    throw new Error(`Invalid DEVIN_SPEED "${speed}". Expected one of: ${[...VALID_SPEEDS].join(", ")}`);
  }
  if (!VALID_SHOW_TOOLS.has(showTools)) {
    throw new Error(`Invalid DEVIN_SHOW_TOOLS "${showTools}". Expected one of: ${[...VALID_SHOW_TOOLS].join(", ")}`);
  }
  if (!VALID_PROCESS_MODELS.has(processModel)) {
    throw new Error(
      `Invalid DEVIN_PROCESS_MODEL "${processModel}". Expected one of: ${[...VALID_PROCESS_MODELS].join(", ")}`,
    );
  }

  const antigravityPath = resolveAntigravityExecutable(cliString(cli, "antigravity-path"));
  const antigravityGeminiDir =
    (cliString(cli, "antigravity-gemini-dir") ?? process.env.ANTIGRAVITY_GEMINI_DIR ?? "").trim() || undefined;
  const rawAppDataDir = (cliString(cli, "antigravity-app-data-dir") ?? "").trim();
  const antigravityAppDataDir = rawAppDataDir || undefined;
  const antigravityAccounts = discoverAntigravityAccounts({
    explicitGeminiDir: antigravityGeminiDir,
    explicitAppDataDir: antigravityAppDataDir,
    explicitAccountsEnv: cliString(cli, "antigravity-accounts") ?? process.env.ANTIGRAVITY_ACCOUNTS,
  });

  const opencodePath = resolveOpencodeExecutable(cliString(cli, "opencode-path"));
  const grokPath = resolveGrokExecutable(cliString(cli, "grok-path"));
  const codexPath = resolveCodexExecutable(cliString(cli, "codex-path"));
  const copilotPath = resolveCopilotExecutable(cliString(cli, "copilot-path"));
  const cursorPath = resolveCursorExecutable(cliString(cli, "cursor-path"));
  const clinePath = resolveClineExecutable(cliString(cli, "cline-path"));
  const mistralPath = resolveMistralExecutable(cliString(cli, "mistral-path"));
  const kimiPath = resolveKimiExecutable(cliString(cli, "kimi-path"));
  const hermesPath = resolveHermesExecutable(cliString(cli, "hermes-path"));
  const customAcpAgents = parseCustomAcpAgents(cliString(cli, "custom-acp") ?? process.env.CUSTOM_ACP_AGENTS);

  const openaiPortRaw = cliString(cli, "openai-port") ?? process.env.OPENAI_PORT;
  const openaiPort = openaiPortRaw ? parseIntEnv(openaiPortRaw, 8788) : null;

  const opencodeProvidersRaw = (
    cliString(cli, "opencode-providers") ??
    process.env.OPENCODE_PROVIDERS ??
    ""
  ).trim();
  const opencodeProviders = opencodeProvidersRaw
    ? opencodeProvidersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const opencodeFilterRaw = (
    cliString(cli, "opencode-filter") ??
    process.env.OPENCODE_FILTER ??
    (opencodeProviders.length > 0 ? "custom" : "go-free")
  )
    .trim()
    .toLowerCase() as OpenCodeFilterMode;
  if (!VALID_OPENCODE_FILTERS.has(opencodeFilterRaw)) {
    throw new Error(
      `Invalid OPENCODE_FILTER "${opencodeFilterRaw}". Expected one of: ${[...VALID_OPENCODE_FILTERS].join(", ")}`,
    );
  }

  return {
    help: Boolean(cli.help),
    host: (cliString(cli, "host") ?? process.env.HOST ?? "127.0.0.1").trim(),
    port: parseIntEnv(cliString(cli, "port") ?? process.env.PORT, 8787),
    devinPath: resolveDevinExecutable(cliString(cli, "devin-path")),
    cwd: resolve((cliString(cli, "cwd") ?? process.env.DEVIN_CWD ?? homedir()).trim()),
    mode,
    defaultModel: (cliString(cli, "model") ?? process.env.DEVIN_MODEL ?? "swe-2-1-medium").trim(),
    thoughtLevel,
    speed,
    showTools,
    processModel,
    apiKey: (cliString(cli, "api-key") ?? process.env.PROXY_API_KEY ?? "").trim() || null,
    modelMap: parseJsonMap(process.env.DEVIN_MODEL_MAP),
    gatewayAliases: parseBoolEnv(cliString(cli, "gateway-aliases") ?? process.env.DEVIN_GATEWAY_ALIASES, true),
    requestTimeoutMs: parseIntEnv(cliString(cli, "request-timeout-ms") ?? process.env.DEVIN_REQUEST_TIMEOUT_MS, 600_000),
    startupTimeoutMs: parseIntEnv(cliString(cli, "startup-timeout-ms") ?? process.env.DEVIN_STARTUP_TIMEOUT_MS, 45_000),
    idleSessionTtlMs: parseIntEnv(cliString(cli, "idle-ttl-ms") ?? process.env.DEVIN_IDLE_SESSION_TTL_MS, 30 * 60_000),
    maxSessions: parseIntEnv(cliString(cli, "max-sessions") ?? process.env.DEVIN_MAX_SESSIONS, 12),
    debug: parseBoolEnv(cliString(cli, "debug") ?? process.env.DEVIN_PROXY_DEBUG, false),
    enableDevin: parseBoolEnv(cliString(cli, "devin") ?? process.env.ENABLE_DEVIN, true),
    enableAntigravity: parseBoolEnv(
      cliString(cli, "antigravity") ?? process.env.ENABLE_ANTIGRAVITY,
      Boolean(antigravityPath && antigravityAccounts.length > 0),
    ),
    antigravityPath,
    antigravityGeminiDir,
    antigravityAppDataDir,
    antigravityAccounts,
    enableOpencode: parseBoolEnv(
      cliString(cli, "opencode") ?? process.env.ENABLE_OPENCODE,
      Boolean(opencodePath),
    ),
    opencodePath,
    opencodeFilter: opencodeFilterRaw,
    opencodeProviders,
    enableGrok: parseBoolEnv(cliString(cli, "grok") ?? process.env.ENABLE_GROK, Boolean(grokPath)),
    grokPath,
    xaiApiKey: (cliString(cli, "xai-api-key") ?? process.env.XAI_API_KEY ?? "").trim() || undefined,
    enableCodex: parseBoolEnv(cliString(cli, "codex") ?? process.env.ENABLE_CODEX, Boolean(codexPath)),
    codexPath,
    enableAnthropic: parseBoolEnv(cliString(cli, "anthropic") ?? process.env.ENABLE_ANTHROPIC, true),
    enableOpenai: parseBoolEnv(cliString(cli, "openai") ?? process.env.ENABLE_OPENAI, true),
    openaiPort,
    enableCopilot: parseBoolEnv(cliString(cli, "copilot") ?? process.env.ENABLE_COPILOT, Boolean(copilotPath)),
    copilotPath,
    enableCursor: parseBoolEnv(cliString(cli, "cursor") ?? process.env.ENABLE_CURSOR, Boolean(cursorPath)),
    cursorPath,
    enableCline: parseBoolEnv(cliString(cli, "cline") ?? process.env.ENABLE_CLINE, Boolean(clinePath)),
    clinePath,
    enableMistral: parseBoolEnv(cliString(cli, "mistral") ?? process.env.ENABLE_MISTRAL, Boolean(mistralPath)),
    mistralPath,
    enableKimi: parseBoolEnv(cliString(cli, "kimi") ?? process.env.ENABLE_KIMI, Boolean(kimiPath)),
    kimiPath,
    enableHermes: parseBoolEnv(cliString(cli, "hermes") ?? process.env.ENABLE_HERMES, Boolean(hermesPath)),
    hermesPath,
    customAcpAgents,
  };
}

export function helpText(): string {
  return `AI-Anthropic-Proxy - Multi-backend local Anthropic & OpenAI API proxy

Usage:
  npm start -- [options]
  npm run dev -- [options]
  node dist/index.js [options]

Options:
  --port <port>                HTTP listen port (default: 8787, env: PORT)
  --openai-port <port>         Optional dedicated OpenAI/Codex listener port (env: OPENAI_PORT)
  --host <host>                HTTP listen host (default: 127.0.0.1, env: HOST)
  --no-anthropic               Disable Anthropic endpoints (env: ENABLE_ANTHROPIC=false)
  --no-openai                  Disable OpenAI endpoints (env: ENABLE_OPENAI=false)
  --cwd <path>                 Default workspace directory (env: DEVIN_CWD)
  --mode <mode>                Permission mode: bypass | accept-edits | smart | ask | plan (default: bypass)
  --model <model>              Fallback model id when client sends unknown id (default: swe-2-1-medium)
  --thought-level <level>      Default effort: none | low | medium | high | xhigh | max (env: DEVIN_THOUGHT_LEVEL)
  --speed <speed>              Default speed: standard | fast | ultrafast (env: DEVIN_SPEED)
  --show-tools <mode>          Show tool calls in: thinking | text | none (default: thinking)
  --process-model <mode>       Devin process model: in-process | daemon (default: in-process)
  --devin-path <path>          Explicit path to devin executable (env: DEVIN_PATH)
  --no-devin                   Disable Devin backend (env: ENABLE_DEVIN=false)
  --antigravity-path <path>    Path to antigravity CLI (env: ANTIGRAVITY_PATH)
  --antigravity-accounts <val> Comma-separated dirs or JSON account array (env: ANTIGRAVITY_ACCOUNTS)
  --no-antigravity             Disable Antigravity (Gemini) backend (env: ENABLE_ANTIGRAVITY=false)
  --opencode-path <path>       Path to opencode CLI (env: OPENCODE_PATH)
  --opencode-filter <mode>     OpenCode models: go-free | all | custom (env: OPENCODE_FILTER)
  --opencode-providers <list>  Comma-separated provider prefixes for custom filter (env: OPENCODE_PROVIDERS)
  --no-opencode                Disable OpenCode backend (env: ENABLE_OPENCODE=false)
  --grok-path <path>           Path to grok CLI (env: GROK_PATH)
  --no-grok                    Disable Grok backend (env: ENABLE_GROK=false)
  --codex-path <path>          Path to codex CLI (env: CODEX_PATH)
  --no-codex                   Disable Codex (GPT) backend (env: ENABLE_CODEX=false)
  --copilot-path <path>        Path to GitHub Copilot CLI (env: COPILOT_PATH)
  --no-copilot                 Disable Copilot backend (env: ENABLE_COPILOT=false)
  --cursor-path <path>         Path to Cursor CLI (env: CURSOR_PATH)
  --no-cursor                  Disable Cursor backend (env: ENABLE_CURSOR=false)
  --cline-path <path>          Path to Cline CLI (env: CLINE_PATH)
  --no-cline                   Disable Cline backend (env: ENABLE_CLINE=false)
  --mistral-path <path>        Path to Mistral Vibe CLI (env: MISTRAL_PATH)
  --no-mistral                 Disable Mistral backend (env: ENABLE_MISTRAL=false)
  --kimi-path <path>           Path to Kimi CLI (env: KIMI_PATH)
  --no-kimi                    Disable Kimi backend (env: ENABLE_KIMI=false)
  --hermes-path <path>         Path to Hermes CLI (env: HERMES_PATH)
  --no-hermes                  Disable Hermes backend (env: ENABLE_HERMES=false)
  --custom-acp <json>          JSON array of custom ACP agents (env: CUSTOM_ACP_AGENTS)
  --api-key <key>              Require Bearer / x-api-key auth (optional, env: PROXY_API_KEY)
  --no-gateway-aliases         Serve raw IDs in /v1/models (env: DEVIN_GATEWAY_ALIASES=false)
  --debug                      Verbose ACP/RPC/HTTP debug logs (env: DEVIN_PROXY_DEBUG=1)
`;
}
