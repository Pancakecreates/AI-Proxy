import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const VALID_MODES = new Set(["bypass", "accept-edits", "smart", "ask", "plan"]);
const VALID_THOUGHT_LEVELS = new Set(["medium", "high", "max"]);
const VALID_SHOW_TOOLS = new Set(["thinking", "text", "none"]);
const VALID_PROCESS_MODELS = new Set(["in-process", "daemon"]);

/**
 * Resolve the Devin CLI executable path automatically from env, OpenBot runtime cache, or PATH.
 */
export function resolveDevinExecutable(explicitPath) {
  const candidates = [explicitPath, process.env.DEVIN_PATH, process.env.OPENBOT_DEVIN_PATH].filter(Boolean);
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

function parseIntEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const norm = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(norm)) return true;
  if (["0", "false", "no", "off"].includes(norm)) return false;
  return fallback;
}

function parseJsonMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = "true";
    }
    args[key] = value;
  }
  return args;
}

function loadDotEnvIfPresent() {
  const envFile = resolve(process.cwd(), ".env");
  if (!existsSync(envFile) || typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Ignore malformed optional .env
  }
}

export function loadConfig(argv = process.argv.slice(2)) {
  loadDotEnvIfPresent();
  const cli = parseCliArgs(argv);
  const mode = String(cli.mode ?? process.env.DEVIN_MODE ?? "bypass").trim();
  const thoughtLevelRaw = cli["thought-level"] ?? process.env.DEVIN_THOUGHT_LEVEL ?? "";
  const thoughtLevel = thoughtLevelRaw ? String(thoughtLevelRaw).trim() : null;
  const showTools = String(cli["show-tools"] ?? process.env.DEVIN_SHOW_TOOLS ?? "thinking").trim();
  const processModel = String(cli["process-model"] ?? process.env.DEVIN_PROCESS_MODEL ?? "in-process").trim();

  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid DEVIN_MODE "${mode}". Expected one of: ${[...VALID_MODES].join(", ")}`);
  }
  if (thoughtLevel && !VALID_THOUGHT_LEVELS.has(thoughtLevel)) {
    throw new Error(`Invalid DEVIN_THOUGHT_LEVEL "${thoughtLevel}". Expected one of: ${[...VALID_THOUGHT_LEVELS].join(", ")}`);
  }
  if (!VALID_SHOW_TOOLS.has(showTools)) {
    throw new Error(`Invalid DEVIN_SHOW_TOOLS "${showTools}". Expected one of: ${[...VALID_SHOW_TOOLS].join(", ")}`);
  }
  if (!VALID_PROCESS_MODELS.has(processModel)) {
    throw new Error(`Invalid DEVIN_PROCESS_MODEL "${processModel}". Expected one of: ${[...VALID_PROCESS_MODELS].join(", ")}`);
  }

  return {
    help: Boolean(cli.help),
    host: String(cli.host ?? process.env.HOST ?? "127.0.0.1").trim(),
    port: parseIntEnv(cli.port ?? process.env.PORT, 8787),
    devinPath: resolveDevinExecutable(cli["devin-path"]),
    cwd: resolve(String(cli.cwd ?? process.env.DEVIN_CWD ?? homedir())),
    mode,
    defaultModel: String(cli.model ?? process.env.DEVIN_MODEL ?? "swe-2-1-medium").trim(),
    thoughtLevel,
    showTools,
    processModel,
    apiKey: String(cli["api-key"] ?? process.env.PROXY_API_KEY ?? "").trim() || null,
    modelMap: parseJsonMap(process.env.DEVIN_MODEL_MAP),
    requestTimeoutMs: parseIntEnv(cli["request-timeout-ms"] ?? process.env.DEVIN_REQUEST_TIMEOUT_MS, 600_000),
    startupTimeoutMs: parseIntEnv(cli["startup-timeout-ms"] ?? process.env.DEVIN_STARTUP_TIMEOUT_MS, 45_000),
    idleSessionTtlMs: parseIntEnv(cli["idle-ttl-ms"] ?? process.env.DEVIN_IDLE_SESSION_TTL_MS, 30 * 60_000),
    maxSessions: parseIntEnv(cli["max-sessions"] ?? process.env.DEVIN_MAX_SESSIONS, 12),
    debug: parseBoolEnv(cli.debug ?? process.env.DEVIN_PROXY_DEBUG, false),
  };
}

export function helpText() {
  return `AI-Anthropic-Proxy - Local Anthropic Messages API proxy over devin acp

Usage:
  node src/index.mjs [options]

Options:
  --port <port>              HTTP listen port (default: 8787, env: PORT)
  --host <host>              HTTP listen host (default: 127.0.0.1, env: HOST)
  --cwd <path>               Default workspace directory for Devin sessions (env: DEVIN_CWD)
  --mode <mode>              Devin ACP mode: bypass | accept-edits | smart | ask | plan (default: bypass)
  --model <model>            Fallback Devin model id when client sends unknown id (default: swe-2-1-medium)
  --thought-level <level>    Default thought level: medium | high | max (env: DEVIN_THOUGHT_LEVEL)
  --show-tools <mode>        Show tool calls in: thinking | text | none (default: thinking)
  --process-model <mode>     Devin process model: in-process | daemon (default: in-process)
  --devin-path <path>        Explicit path to devin executable (env: DEVIN_PATH)
  --api-key <key>            Require Bearer / x-api-key auth (optional, env: PROXY_API_KEY)
  --debug                    Verbose ACP/HTTP debug logs (env: DEVIN_PROXY_DEBUG=1)
`;
}
