import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DevinMode, ProcessModel, ProxyConfig, ShowToolsMode, SpeedMode, ThoughtLevel } from "./types.js";

const VALID_MODES = new Set<DevinMode>(["bypass", "accept-edits", "smart", "ask", "plan"]);
const VALID_THOUGHT_LEVELS = new Set<ThoughtLevel>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const VALID_SPEEDS = new Set<SpeedMode>(["standard", "fast", "ultrafast"]);
const VALID_SHOW_TOOLS = new Set<ShowToolsMode>(["thinking", "text", "none"]);
const VALID_PROCESS_MODELS = new Set<ProcessModel>(["in-process", "daemon"]);

/**
 * Resolve the Devin CLI executable path automatically from env, OpenBot runtime cache, or PATH.
 */
export function resolveDevinExecutable(explicitPath?: string): string {
  const candidates = [explicitPath, process.env.DEVIN_PATH, process.env.OPENBOT_DEVIN_PATH].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }

  const platformDir =
    process.platform === "win32"
      ? "win32-x64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "darwin-arm64"
          : "darwin-x64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : "linux-x64";
  const exeName = process.platform === "win32" ? "devin.exe" : "devin";

  const appData =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".config"));

  const runtimeRoot = join(appData, "OpenBot", "provider-runtimes", "devin", platformDir);
  if (existsSync(runtimeRoot)) {
    const versions = readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(runtimeRoot, version, "bin", exeName);
      if (existsSync(candidate)) return candidate;
    }
  }

  return exeName;
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
  };
}

export function helpText(): string {
  return `AI-Anthropic-Proxy - Local Anthropic Messages API proxy over devin acp

Usage:
  npm start -- [options]
  npm run dev -- [options]
  node dist/index.js [options]

Options:
  --port <port>              HTTP listen port (default: 8787, env: PORT)
  --host <host>              HTTP listen host (default: 127.0.0.1, env: HOST)
  --cwd <path>               Default workspace directory for Devin sessions (env: DEVIN_CWD)
  --mode <mode>              Devin ACP mode: bypass | accept-edits | smart | ask | plan (default: bypass)
  --model <model>            Fallback Devin model id when client sends unknown id (default: swe-2-1-medium)
  --thought-level <level>    Default effort: none | low | medium | high | xhigh | max (env: DEVIN_THOUGHT_LEVEL)
  --speed <speed>            Default speed: standard | fast | ultrafast (env: DEVIN_SPEED)
  --show-tools <mode>        Show tool calls in: thinking | text | none (default: thinking)
  --process-model <mode>     Devin process model: in-process | daemon (default: in-process)
  --devin-path <path>        Explicit path to devin executable (env: DEVIN_PATH)
  --api-key <key>            Require Bearer / x-api-key auth (optional, env: PROXY_API_KEY)
  --no-gateway-aliases       Serve raw non-Claude IDs in /v1/models (env: DEVIN_GATEWAY_ALIASES=false)
  --debug                    Verbose ACP/HTTP debug logs (env: DEVIN_PROXY_DEBUG=1)
`;
}
