import type {
  AcpAvailableModelFallback,
  AcpConfigGroupOption,
  AcpConfigOption,
  AcpConfigSelectOption,
  AnthropicModelInfo,
  AnthropicModelLine,
  AnthropicModelsListResponse,
  AnthropicOutputConfig,
  AnthropicThinkingConfig,
  BackendModelEntry,
  ConfigCatalog,
  DevinModelEntry,
  OpenCodeFilterMode,
  SpeedMode,
  ThoughtConfigId,
  ThoughtLevel,
} from "./types.js";

const CREATED_AT_ISO = "2026-01-01T00:00:00Z";

const EFFORT_SCALE: readonly ThoughtLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SUFFIX_RE = /-(none|minimal|low|medium|high|xhigh|max)$/i;
const SPEED_SUFFIX_RE = /-(lightning|ultrafast|fast)$/i;

const GATEWAY_ALIAS_PREFIX = "claude-fable-acp-";
const GATEWAY_SAFE_HEX_PREFIX = "h-";
const SAFE_HEX_ALPHABET = "0123456789cfjquw";
const CLAUDE_TIER_KEYWORDS = ["sonnet", "opus", "haiku", "fable", "mythos"] as const;
const CLAUDE_TIER_DISPLAY_RE = /^(opus|sonnet|haiku|fable|mythos)\b/i;

/**
 * Normalize a model display name that Devin returns without the "Claude" brand prefix.
 * Example: "Opus 4.6" → "Claude Opus 4.6", "Claude Opus 4.6 Thinking" is left unchanged.
 */
function normalizeTierDisplayName(name: string): string {
  if (CLAUDE_TIER_DISPLAY_RE.test(name) && !/^claude\b/i.test(name)) {
    return `Claude ${name}`;
  }
  return name;
}

const CLAUDE_ALLOWED_KEYWORDS = ["claude", ...CLAUDE_TIER_KEYWORDS, "anthropic"] as const;
const GATEWAY_TIER_EXACT_RE = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/;
const NON_ANTHROPIC_BLOCKLIST_RE =
  /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;

const OPENCODE_FREE_EXACT_IDS = new Set(["opencode/big-pickle"]);

export interface ResolvedModelSelection {
  model: DevinModelEntry;
  requestedEffort: ThoughtLevel | null;
  requestedSpeed: SpeedMode | null;
}

/**
 * Check whether an OpenCode model is free (matches OpenBot's free model rules).
 */
export function isFreeOpencodeModel(id: string, name = ""): boolean {
  const normId = id.trim().toLowerCase();
  if (OPENCODE_FREE_EXACT_IDS.has(normId)) return true;
  if (/-free$/i.test(normId)) return true;
  return /\bfree$/i.test(name.trim());
}

/**
 * Filter OpenCode models according to OPENCODE_FILTER (`go-free`, `all`, or `custom` prefixes).
 */
export function filterOpencodeModels(
  models: readonly DevinModelEntry[],
  mode: OpenCodeFilterMode = "go-free",
  customProviders: readonly string[] = [],
): DevinModelEntry[] {
  if (mode === "all") return [...models];
  if (mode === "custom" && customProviders.length > 0) {
    const prefixes = customProviders.map((p) => p.trim().toLowerCase()).filter(Boolean);
    return models.filter((m) => {
      const lower = m.id.toLowerCase();
      return prefixes.some((prefix) =>
        prefix.endsWith("/") ? lower.startsWith(prefix) : lower.startsWith(`${prefix}/`) || lower === prefix,
      );
    });
  }
  return models.filter((m) => {
    const lower = m.id.toLowerCase();
    return lower.startsWith("opencode-go/") || (lower.startsWith("opencode/") && isFreeOpencodeModel(m.id, m.name));
  });
}

/**
 * Check whether a model ID passes Claude Desktop Gateway's Anthropic-only route filter.
 */
export function isClaudeDesktopCompatibleId(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (!lower || NON_ANTHROPIC_BLOCKLIST_RE.test(lower)) return false;
  return GATEWAY_TIER_EXACT_RE.test(lower) || CLAUDE_ALLOWED_KEYWORDS.some((kw) => lower.includes(kw));
}

function encodeSafeHex(input: string): string {
  const bytes = Buffer.from(input, "utf8");
  let out = "";
  for (const byte of bytes) {
    out += SAFE_HEX_ALPHABET[(byte >> 4) & 0x0f]! + SAFE_HEX_ALPHABET[byte & 0x0f]!;
  }
  return out;
}

function decodeSafeHex(encoded: string): string | null {
  if (!encoded || encoded.length % 2 !== 0) return null;
  const bytes = Buffer.alloc(encoded.length / 2);
  for (let i = 0; i < encoded.length; i += 2) {
    const hi = SAFE_HEX_ALPHABET.indexOf(encoded[i]!);
    const lo = SAFE_HEX_ALPHABET.indexOf(encoded[i + 1]!);
    if (hi < 0 || lo < 0) return null;
    bytes[i / 2] = (hi << 4) | lo;
  }
  return bytes.toString("utf8");
}

/**
 * Convert a model ID into a lossless Claude Desktop Gateway alias.
 * Uses the `claude-fable-acp-` prefix so Claude Desktop admits it and enables effort controls.
 */
export function toGatewayModelId(nativeId: string, forceAlias = false): string {
  if (!forceAlias && isClaudeDesktopCompatibleId(nativeId)) return nativeId;

  if (!nativeId.includes("--") && /^[a-z0-9._-]+$/.test(nativeId)) {
    let body = nativeId;
    for (let step = 0; step < 32 && NON_ANTHROPIC_BLOCKLIST_RE.test(body); step += 1) {
      const next = body.replace(NON_ANTHROPIC_BLOCKLIST_RE, (match) => `${match[0]}--${match.slice(1)}`);
      if (next === body) break;
      body = next;
    }

    const readable = `${GATEWAY_ALIAS_PREFIX}${body}`;
    if (
      readable.length <= 245 &&
      !body.startsWith(GATEWAY_SAFE_HEX_PREFIX) &&
      isClaudeDesktopCompatibleId(readable) &&
      decodeGatewayModelId(readable) === nativeId
    ) {
      return readable;
    }
  }

  return `${GATEWAY_ALIAS_PREFIX}${GATEWAY_SAFE_HEX_PREFIX}${encodeSafeHex(nativeId)}`;
}

/**
 * Decode a proxy-generated Claude Desktop Gateway alias back to its original ID.
 */
export function decodeGatewayModelId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed.toLowerCase().startsWith(GATEWAY_ALIAS_PREFIX)) return null;
  const body = trimmed.slice(GATEWAY_ALIAS_PREFIX.length);
  if (!body) return null;
  if (body.toLowerCase().startsWith(GATEWAY_SAFE_HEX_PREFIX)) {
    return decodeSafeHex(body.slice(GATEWAY_SAFE_HEX_PREFIX.length).toLowerCase());
  }
  return body.replaceAll("--", "");
}

function isThoughtOption(option: AcpConfigOption): ThoughtConfigId | null {
  if (option.id === "thought_level" || option.category === "thought_level") {
    if (option.id === "effort" || option.id === "reasoning_effort" || option.id === "thought_level") {
      return option.id;
    }
    return "thought_level";
  }
  if (option.id === "effort" || option.id === "reasoning_effort") {
    return option.id;
  }
  return null;
}

/**
 * Extract structured model, mode, thought_level/effort, and speed catalogs from ACP configOptions.
 */
export function parseConfigCatalog(
  configOptions: readonly AcpConfigOption[] | undefined,
  fallbackModels?: readonly AcpAvailableModelFallback[],
): ConfigCatalog {
  const result: ConfigCatalog = {
    models: [],
    modes: [],
    thoughtLevels: [],
    thoughtConfigId: null,
    thoughtWireValues: {},
    speeds: [],
    currentModel: null,
    currentMode: null,
    currentThoughtLevel: null,
    currentSpeed: null,
  };
  if (Array.isArray(configOptions)) {
    for (const option of configOptions) {
      if (!option || typeof option !== "object") continue;
      const entries = flattenSelectOptions(option.options);
      if (option.id === "model") {
        result.currentModel = typeof option.currentValue === "string" ? option.currentValue : null;
        result.models = entries.map((entry) => ({
          id: entry.value,
          name: normalizeTierDisplayName(entry.name || entry.value),
          supportsImages:
            entry._meta && "cognition.ai/supportsImages" in entry._meta
              ? Boolean(entry._meta["cognition.ai/supportsImages"])
              : true,
          ...(entry.description ? { description: entry.description } : {}),
        }));
      } else if (option.id === "mode") {
        result.currentMode = typeof option.currentValue === "string" ? option.currentValue : null;
        result.modes = entries.map((entry) => entry.value);
      } else if (option.id === "speed") {
        result.currentSpeed = typeof option.currentValue === "string" ? (option.currentValue as SpeedMode) : null;
        result.speeds = entries.map((entry) => entry.value as SpeedMode);
      } else {
        const thoughtId = isThoughtOption(option);
        if (thoughtId) {
          result.thoughtConfigId = thoughtId;
          result.currentThoughtLevel =
            typeof option.currentValue === "string" ? normalizeEffortValue(option.currentValue) : null;
          const levels: ThoughtLevel[] = [];
          for (const entry of entries) {
            const normalized = normalizeEffortValue(entry.value);
            if (!normalized) continue;
            if (!levels.includes(normalized)) levels.push(normalized);
            result.thoughtWireValues[normalized] = entry.value;
          }
          result.thoughtLevels = levels;
        }
      }
    }
  }

  if (result.models.length === 0 && Array.isArray(fallbackModels) && fallbackModels.length > 0) {
    result.models = fallbackModels
      .filter((m) => m && typeof m.modelId === "string" && m.modelId.trim())
      .map((m) => ({
        id: m.modelId,
        name: normalizeTierDisplayName(m.name || m.modelId),
        supportsImages: true,
        ...(m.description ? { description: m.description } : {}),
      }));
  }

  return result;
}

function isGroupOption(entry: AcpConfigSelectOption | AcpConfigGroupOption): entry is AcpConfigGroupOption {
  return "options" in entry && Array.isArray(entry.options);
}

function flattenSelectOptions(
  options: readonly (AcpConfigSelectOption | AcpConfigGroupOption)[] | undefined,
): AcpConfigSelectOption[] {
  if (!Array.isArray(options)) return [];
  const flat: AcpConfigSelectOption[] = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    if (isGroupOption(entry)) {
      for (const nested of entry.options) {
        if (nested && typeof nested === "object" && typeof nested.value === "string") {
          flat.push(nested);
        }
      }
    } else if (typeof entry.value === "string") {
      flat.push(entry);
    }
  }
  return flat;
}

/**
 * Peel optional speed and effort suffixes (e.g. `swe-2-1-xhigh-lightning`, `deepseek-v4-pro-max`)
 * while preserving exact ACP catalog IDs untouched.
 */
export function peelEffortAndSpeedSuffixes(slug: string): {
  baseSlug: string;
  effort: ThoughtLevel | null;
  speed: SpeedMode | null;
} {
  let baseSlug = slug;
  let speed: SpeedMode | null = null;
  let effort: ThoughtLevel | null = null;

  const speedMatch = SPEED_SUFFIX_RE.exec(baseSlug);
  if (speedMatch?.[1]) {
    const token = speedMatch[1].toLowerCase();
    speed = token === "fast" ? "fast" : "ultrafast";
    baseSlug = baseSlug.slice(0, -speedMatch[0].length);
  }

  const effortMatch = EFFORT_SUFFIX_RE.exec(baseSlug);
  if (effortMatch?.[1]) {
    effort = effortMatch[1].toLowerCase() as ThoughtLevel;
    baseSlug = baseSlug.slice(0, -effortMatch[0].length);
  }

  return { baseSlug, effort, speed };
}

function stripTrailingEffort(id: string): string {
  return id.replace(EFFORT_SUFFIX_RE, "");
}

function lookupModelMap(raw: string, modelMap: Record<string, string>): string | undefined {
  if (!raw) return undefined;
  return modelMap[raw] ?? modelMap[raw.toLowerCase()];
}

/**
 * Resolve requested model string to a Devin ACP base model ID plus optional effort/speed hints.
 */
export function resolveDevinModelWithHints(
  requestedModel: string | undefined,
  catalogModels: readonly DevinModelEntry[],
  options: { defaultModel?: string; modelMap?: Record<string, string> } = {},
): ResolvedModelSelection {
  const defaultModel = options.defaultModel ?? "swe-2-1-medium";
  const modelMap = options.modelMap ?? {};

  const raw = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const strippedRaw1m = raw.replace(/\[1m\]$/i, "").trim();
  const mappedRaw =
    lookupModelMap(raw, modelMap) ??
    (strippedRaw1m !== raw ? lookupModelMap(strippedRaw1m, modelMap) : undefined) ??
    raw;

  if (!mappedRaw) {
    return {
      model: findCatalogModel(defaultModel, catalogModels) ?? {
        id: defaultModel,
        name: defaultModel,
        supportsImages: true,
      },
      requestedEffort: null,
      requestedSpeed: null,
    };
  }

  const candidates = [mappedRaw];
  if (/\[1m\]$/i.test(mappedRaw)) {
    const stripped = mappedRaw.replace(/\[1m\]$/i, "").trim();
    candidates.push(`${stripped}-1m`, stripped);
  }

  for (const candidate of candidates) {
    const exact = findCatalogModel(candidate, catalogModels);
    if (exact) {
      return { model: exact, requestedEffort: null, requestedSpeed: null };
    }
    const decoded = decodeGatewayModelId(candidate);
    if (decoded) {
      const exactDecoded = findCatalogModel(decoded, catalogModels);
      if (exactDecoded) {
        return { model: exactDecoded, requestedEffort: null, requestedSpeed: null };
      }
    }
  }

  const mapped = candidates[candidates.length - 1] ?? mappedRaw;
  const effectiveSlug = decodeGatewayModelId(mapped) ?? mapped;
  const { baseSlug, effort, speed } = peelEffortAndSpeedSuffixes(effectiveSlug);

  if (baseSlug && baseSlug !== effectiveSlug) {
    const exactBase = findCatalogModel(baseSlug, catalogModels);
    if (exactBase) {
      return { model: exactBase, requestedEffort: effort, requestedSpeed: speed };
    }
    const baseLower = normalizeSlug(baseSlug);
    const byFamilySlug = findBestMatch(
      catalogModels,
      (m) => !m.id.includes("fusion") && normalizeSlug(stripTrailingEffort(m.id)) === baseLower,
    );
    if (byFamilySlug) {
      return { model: byFamilySlug, requestedEffort: effort, requestedSpeed: speed };
    }
  }

  const searchSlug = baseSlug || effectiveSlug;
  const lower = searchSlug.toLowerCase();

  if (lower.includes("haiku")) {
    const haiku = findBestMatch(catalogModels, (m) => m.id.includes("haiku") && !m.id.includes("fusion"));
    if (haiku) return { model: haiku, requestedEffort: effort, requestedSpeed: speed };
  }
  if (lower.includes("sonnet")) {
    const sonnet = findBestMatch(catalogModels, (m) => m.id.includes("sonnet") && !m.id.includes("fusion"));
    if (sonnet) return { model: sonnet, requestedEffort: effort, requestedSpeed: speed };
  }
  if (lower.includes("opus")) {
    const opus = findBestMatch(catalogModels, (m) => m.id.includes("opus") && !m.id.includes("fusion"));
    if (opus) return { model: opus, requestedEffort: effort, requestedSpeed: speed };
  }
  if (lower.includes("fable")) {
    const fable = findBestMatch(catalogModels, (m) => m.id.includes("fable") && !m.id.includes("fusion"));
    if (fable) return { model: fable, requestedEffort: effort, requestedSpeed: speed };
  }

  const norm = normalizeSlug(lower);
  const fuzzy = findBestMatch(
    catalogModels,
    (m) => !m.id.includes("fusion") && (normalizeSlug(m.id).includes(norm) || normalizeSlug(m.name).includes(norm)),
  );
  if (fuzzy) return { model: fuzzy, requestedEffort: effort, requestedSpeed: speed };

  if (catalogModels.length === 0) {
    return {
      model: { id: effectiveSlug, name: effectiveSlug, supportsImages: true },
      requestedEffort: effort,
      requestedSpeed: speed,
    };
  }

  return {
    model: findCatalogModel(defaultModel, catalogModels) ?? catalogModels[0]!,
    requestedEffort: effort,
    requestedSpeed: speed,
  };
}

export function resolveDevinModel(
  requestedModel: string | undefined,
  catalogModels: readonly DevinModelEntry[],
  options: { defaultModel?: string; modelMap?: Record<string, string> } = {},
): DevinModelEntry {
  return resolveDevinModelWithHints(requestedModel, catalogModels, options).model;
}

function findCatalogModel(candidate: string, models: readonly DevinModelEntry[]): DevinModelEntry | null {
  if (!candidate || models.length === 0) return null;
  const lower = candidate.toLowerCase();
  return (
    models.find((m) => m.id === candidate) ??
    models.find((m) => m.id.toLowerCase() === lower) ??
    models.find((m) => m.name.toLowerCase() === lower) ??
    null
  );
}

function findBestMatch(
  models: readonly DevinModelEntry[],
  predicate: (model: DevinModelEntry) => boolean,
): DevinModelEntry | null {
  const candidates = models.filter(predicate);
  if (candidates.length === 0) return null;
  return (
    candidates.find((m) => m.id.endsWith("-medium")) ??
    candidates.find((m) => m.id.endsWith("-high")) ??
    candidates[0] ??
    null
  );
}

function normalizeSlug(value: string): string {
  return value.toLowerCase().replace(/[.\s_]+/g, "-");
}

export function normalizeEffortValue(raw: string | null | undefined): ThoughtLevel | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase().replaceAll("-", "_");
  if (norm === "none" || norm === "off") return "none";
  if (norm === "minimal") return "minimal";
  if (norm === "low") return "low";
  if (norm === "medium") return "medium";
  if (norm === "high" || norm === "on") return "high";
  if (norm === "xhigh" || norm === "extra" || norm === "extra_high" || norm === "very_high") return "xhigh";
  if (norm === "max" || norm === "ultra") return "max";
  return null;
}

/**
 * Pick the nearest supported effort level on the ordered scale for a specific model.
 */
export function fitSupportedEffort(
  desired: ThoughtLevel | null,
  supportedLevels: readonly ThoughtLevel[],
): ThoughtLevel | null {
  if (!desired) return null;
  if (supportedLevels.length === 0) return desired;
  if (supportedLevels.includes(desired)) return desired;

  const desiredIdx = EFFORT_SCALE.indexOf(desired);
  if (desiredIdx < 0) return supportedLevels[0] ?? null;

  let best: ThoughtLevel | null = null;
  let bestDist = Infinity;
  for (const candidate of supportedLevels) {
    const idx = EFFORT_SCALE.indexOf(candidate);
    if (idx < 0) continue;
    const dist = Math.abs(idx - desiredIdx);
    // Prefer slightly higher capability on ties so e.g. medium -> high rather than low if equidistant
    if (dist < bestDist || (dist === bestDist && idx > desiredIdx)) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best ?? supportedLevels[0] ?? null;
}

/**
 * Resolve ACP thought_level/effort from model suffix, Anthropic output_config.effort, thinking config, and proxy defaults.
 */
export function resolveThoughtLevel(
  params: {
    requestedEffort?: ThoughtLevel | null;
    outputConfig?: AnthropicOutputConfig | undefined;
    thinking?: AnthropicThinkingConfig | undefined;
    defaultThoughtLevel: ThoughtLevel | null;
  },
  supportedLevels: readonly ThoughtLevel[],
): ThoughtLevel | null {
  let desired: ThoughtLevel | null = params.requestedEffort ?? null;

  if (!desired) {
    desired = normalizeEffortValue(params.outputConfig?.effort);
  }

  if (!desired && params.thinking && typeof params.thinking === "object") {
    if (params.thinking.type === "disabled") {
      desired = "none";
    } else if (params.thinking.type === "enabled") {
      const budget = Number(params.thinking.budget_tokens);
      if (Number.isFinite(budget)) {
        if (budget < 2_048) desired = "low";
        else if (budget < 8_192) desired = "medium";
        else if (budget < 16_000) desired = "high";
        else if (budget < 32_000) desired = "xhigh";
        else desired = "max";
      } else {
        desired = "high";
      }
    } else if (params.thinking.type === "adaptive") {
      desired = params.defaultThoughtLevel ?? "high";
    }
  }

  if (!desired) {
    desired = params.defaultThoughtLevel;
  }

  return fitSupportedEffort(desired, supportedLevels);
}

/**
 * Resolve ACP speed (`standard` / `fast` / `ultrafast`) against the model's supported speed options.
 */
export function resolveSpeed(
  requestedSpeed: SpeedMode | null,
  defaultSpeed: SpeedMode | null,
  supportedSpeeds: readonly SpeedMode[],
): SpeedMode | null {
  const desired = requestedSpeed ?? defaultSpeed;
  if (!desired || supportedSpeeds.length === 0) return null;
  if (supportedSpeeds.includes(desired)) return desired;
  if (desired === "fast" && supportedSpeeds.includes("ultrafast")) return "ultrafast";
  if (desired === "ultrafast" && supportedSpeeds.includes("fast")) return "fast";
  return null;
}

function inferModelLine(id: string): AnthropicModelLine | undefined {
  const lower = id.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("fable")) return "fable";
  return undefined;
}

function inferMaxInputTokens(id: string): number {
  const lower = id.toLowerCase();
  if (
    lower.endsWith("-1m") ||
    lower.includes("gemini") ||
    lower.includes("deepseek") ||
    lower.includes("claude-fable") ||
    lower.includes("claude-opus-5") ||
    lower.includes("claude-sonnet-5")
  ) {
    return 1_000_000;
  }
  if (lower.includes("gpt-") || lower.includes("codex") || lower.includes("grok")) {
    return 400_000;
  }
  return 262_144;
}

/**
 * Format Devin model list as Anthropic GET /v1/models payload with metadata for client pickers.
 */
export function formatAnthropicModelsList(
  catalogModels: readonly DevinModelEntry[],
  defaultModel: string,
  options: { gatewayAliases?: boolean } = {},
): AnthropicModelsListResponse {
  const useGatewayAliases = options.gatewayAliases !== false;
  const list: readonly DevinModelEntry[] =
    catalogModels.length > 0
      ? catalogModels
      : [{ id: defaultModel, name: defaultModel, supportsImages: true }];

  const data: AnthropicModelInfo[] = list.map((model) => {
    const exposedId = useGatewayAliases ? toGatewayModelId(model.id) : model.id;
    const line = inferModelLine(model.id);
    return {
      type: "model",
      id: exposedId,
      display_name: model.name,
      description: `Devin: ${model.id}`.slice(0, 100),
      max_effort_level: "max",
      created_at: CREATED_AT_ISO,
      max_input_tokens: inferMaxInputTokens(model.id),
      max_tokens: 64_000,
      ...(line ? { line } : {}),
      capabilities: {
        thinking: {
          types: {
            enabled: { supported: true },
            adaptive: { supported: true },
            disabled: { supported: true },
          },
        },
      },
    };
  });

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export function formatMultiBackendModelsList(
  models: readonly BackendModelEntry[],
  defaultModel: string,
  options: { gatewayAliases?: boolean } = {},
): AnthropicModelsListResponse {
  const useGatewayAliases = options.gatewayAliases !== false;
  if (models.length === 0) {
    return formatAnthropicModelsList([], defaultModel, options);
  }

  const nameCounts = new Map<string, number>();
  for (const model of models) {
    nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  }
  const usedDisplayNames = new Set<string>();

  const data: AnthropicModelInfo[] = models.map((model) => {
    const isDevin = model.backendKind === "devin";
    const exposedId = useGatewayAliases
      ? isDevin
        ? toGatewayModelId(model.nativeId)
        : toGatewayModelId(model.qualifiedId, true)
      : model.qualifiedId;
    const line = inferModelLine(model.nativeId);
    const description = (model.description ?? `${model.backendLabel}: ${model.nativeId}`).slice(0, 100);
    const providerTag = description.includes(":") ? description.slice(0, description.indexOf(":")).trim() : model.backendLabel;

    let displayName = model.name;
    if ((nameCounts.get(model.name) ?? 0) > 1) {
      if (isDevin && !usedDisplayNames.has(displayName)) {
        // Keep Devin's primary copy clean when colliding with another backend.
      } else {
        displayName = `${model.name} (${providerTag})`;
      }
    }
    if (usedDisplayNames.has(displayName)) {
      let suffix = 2;
      while (usedDisplayNames.has(`${displayName} #${suffix}`)) suffix += 1;
      displayName = `${displayName} #${suffix}`;
    }
    usedDisplayNames.add(displayName);

    return {
      type: "model",
      id: exposedId,
      display_name: displayName,
      description,
      max_effort_level: "max",
      created_at: CREATED_AT_ISO,
      max_input_tokens: inferMaxInputTokens(model.nativeId),
      max_tokens: 64_000,
      ...(line ? { line } : {}),
      capabilities: {
        thinking: {
          types: {
            enabled: { supported: true },
            adaptive: { supported: true },
            disabled: { supported: true },
          },
        },
      },
    };
  });

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

export interface OpenAIModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  description?: string;
  context_window?: number;
}

export interface OpenAIModelsListResponse {
  object: "list";
  data: OpenAIModelInfo[];
}

/**
 * Format multi-backend model catalog (or Devin fallback) as OpenAI GET /v1/models payload.
 */
export function formatOpenAIModelsList(
  models: readonly BackendModelEntry[],
  defaultModel: string,
): OpenAIModelsListResponse {
  const created = 1767225600;
  if (models.length === 0) {
    return {
      object: "list",
      data: [
        {
          id: defaultModel,
          object: "model",
          created,
          owned_by: "devin",
          display_name: defaultModel,
          description: `Devin: ${defaultModel}`,
          context_window: inferMaxInputTokens(defaultModel),
        },
      ],
    };
  }
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.qualifiedId,
      object: "model",
      created,
      owned_by: model.backendKind,
      display_name: model.name,
      description: (model.description ?? `${model.backendLabel}: ${model.nativeId}`).slice(0, 120),
      context_window: inferMaxInputTokens(model.nativeId),
    })),
  };
}
