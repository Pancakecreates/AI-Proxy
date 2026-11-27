import type {
  AntigravityAccountConfig,
  BackendHealthStatus,
  CustomAcpAgentConfig,
} from "./types";

export interface ResolvedAccountInfo {
  brand: string;
  title: string;
  subtitle: string | null;
  key: string | null;
  inferred: boolean;
}

const PROVIDER_META: Record<string, { brand: string; name: string }> = {
  devin: { brand: "devin", name: "Devin" },
  opencode: { brand: "opencode", name: "OpenCode" },
  grok: { brand: "grok", name: "Grok" },
  codex: { brand: "openai", name: "Codex" },
  copilot: { brand: "copilot", name: "Copilot" },
  cursor: { brand: "cursor", name: "Cursor" },
  cline: { brand: "cline", name: "Cline" },
  mistral: { brand: "mistral", name: "Mistral Vibe" },
  kimi: { brand: "kimi", name: "Kimi" },
  hermes: { brand: "hermes", name: "Hermes" },
};

function inferBackendKeyFromModel(model?: string | null): string | null {
  if (!model) return null;
  const low = model.toLowerCase();
  const agyGateway = low.match(/claude-(?:fable|sonnet|opus|haiku)-acp-agy-([a-z0-9_-]+)\./);
  if (agyGateway?.[1]) return `antigravity:${agyGateway[1]}`;
  const agyDirect = low.match(/^agy-([a-z0-9_-]+)\./);
  if (agyDirect?.[1]) return `antigravity:${agyDirect[1]}`;
  if (low.startsWith("oc.") || low.startsWith("oc-") || low.includes("-acp-oc.")) return "opencode";
  if (low.startsWith("grok.") || low.includes("-acp-grok.")) return "grok";
  if (low.startsWith("codex.") || low.includes("-acp-codex.")) return "codex";
  if (low.startsWith("copilot.") || low.includes("-acp-copilot.")) return "copilot";
  if (low.startsWith("cursor.") || low.includes("-acp-cursor.")) return "cursor";
  if (low.startsWith("cline.") || low.includes("-acp-cline.")) return "cline";
  if (low.startsWith("mistral.") || low.includes("-acp-mistral.")) return "mistral";
  if (low.startsWith("kimi.") || low.includes("-acp-kimi.")) return "kimi";
  if (low.startsWith("hermes.") || low.includes("-acp-hermes.")) return "hermes";
  return null;
}

function extractAntigravityInner(label?: string | null): string | null {
  if (!label) return null;
  const m = label.match(/^Antigravity\s+\d+\s*\((.+)\)$/);
  return m?.[1]?.trim() || null;
}

export function resolveAccountInfo(params: {
  backendKey?: string | null;
  accountLabel?: string | null;
  requestedModel?: string | null;
  backends?: BackendHealthStatus[];
  antigravityAccounts?: AntigravityAccountConfig[];
  customAcpAgents?: CustomAcpAgentConfig[];
}): ResolvedAccountInfo {
  const {
    backendKey,
    accountLabel,
    requestedModel,
    backends = [],
    antigravityAccounts = [],
    customAcpAgents = [],
  } = params;

  const inferredKey = !backendKey ? inferBackendKeyFromModel(requestedModel) : null;
  const key = backendKey || inferredKey;
  const inferred = !backendKey && Boolean(inferredKey);

  if (!key) {
    if (accountLabel) {
      return { brand: "custom", title: accountLabel, subtitle: null, key: null, inferred: false };
    }
    return { brand: "custom", title: "—", subtitle: null, key: null, inferred: false };
  }

  if (key.startsWith("antigravity:")) {
    const id = key.slice("antigravity:".length);
    const acc = antigravityAccounts.find((a) => a.id === id);
    const live = backends.find((b) => b.key === key);
    const innerFromLabel = extractAntigravityInner(accountLabel || live?.label || acc?.label);
    const title = acc?.email || innerFromLabel || acc?.label || `Antigravity (${id})`;
    const subtitle = title.includes("Antigravity") ? id : `Antigravity · ${id}`;
    return { brand: "gemini", title, subtitle, key, inferred };
  }

  if (key.startsWith("custom:")) {
    const id = key.slice("custom:".length);
    const custom = customAcpAgents.find((c) => c.id === id);
    const live = backends.find((b) => b.key === key);
    return {
      brand: "custom",
      title: custom?.name || accountLabel || live?.label || id,
      subtitle: "Custom ACP",
      key,
      inferred,
    };
  }

  const meta = PROVIDER_META[key];
  if (meta) {
    return {
      brand: meta.brand,
      title: accountLabel || meta.name,
      subtitle: null,
      key,
      inferred,
    };
  }

  const live = backends.find((b) => b.key === key);
  return {
    brand: live?.kind ?? "custom",
    title: accountLabel || live?.label || key,
    subtitle: null,
    key,
    inferred,
  };
}
