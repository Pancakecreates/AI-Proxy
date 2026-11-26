import type {
  AcpConfigGroupOption,
  AcpConfigOption,
  AcpConfigSelectOption,
  AnthropicModelInfo,
  AnthropicModelLine,
  AnthropicModelsListResponse,
  AnthropicOutputConfig,
  AnthropicThinkingConfig,
  ConfigCatalog,
  DevinMode,
  DevinModelEntry,
  SpeedMode,
  ThoughtLevel,
} from "./types.js";

const CREATED_AT_ISO = "2026-01-01T00:00:00Z";

const EFFORT_SCALE: readonly ThoughtLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SUFFIX_RE = /-(none|minimal|low|medium|high|xhigh|max)$/i;
const SPEED_SUFFIX_RE = /-(lightning|ultrafast|fast)$/i;

export interface ResolvedModelSelection {
  model: DevinModelEntry;
  requestedEffort: ThoughtLevel | null;
  requestedSpeed: SpeedMode | null;
}

/**
 * Extract structured model, mode, thought_level, and speed catalogs from ACP configOptions.
 */
export function parseConfigCatalog(configOptions: readonly AcpConfigOption[] | undefined): ConfigCatalog {
  const result: ConfigCatalog = {
    models: [],
    modes: [],
    thoughtLevels: [],
    speeds: [],
    currentModel: null,
    currentMode: null,
    currentThoughtLevel: null,
    currentSpeed: null,
  };
  if (!Array.isArray(configOptions)) return result;

  for (const option of configOptions) {
    if (!option || typeof option !== "object") continue;
    const entries = flattenSelectOptions(option.options);
    if (option.id === "model") {
      result.currentModel = typeof option.currentValue === "string" ? option.currentValue : null;
      result.models = entries.map((entry) => ({
        id: entry.value,
        name: entry.name || entry.value,
        supportsImages: Boolean(entry._meta?.["cognition.ai/supportsImages"]),
      }));
    } else if (option.id === "mode") {
      result.currentMode = typeof option.currentValue === "string" ? (option.currentValue as DevinMode) : null;
      result.modes = entries.map((entry) => entry.value as DevinMode);
    } else if (option.id === "thought_level") {
      result.currentThoughtLevel =
        typeof option.currentValue === "string" ? (option.currentValue as ThoughtLevel) : null;
      result.thoughtLevels = entries.map((entry) => entry.value as ThoughtLevel);
    } else if (option.id === "speed") {
      result.currentSpeed = typeof option.currentValue === "string" ? (option.currentValue as SpeedMode) : null;
      result.speeds = entries.map((entry) => entry.value as SpeedMode);
    }
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
function peelEffortAndSpeedSuffixes(slug: string): {
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
  const mappedRaw = (raw && (modelMap[raw] ?? modelMap[raw.toLowerCase()])) || raw;

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
  }

  const mapped = candidates[candidates.length - 1] ?? mappedRaw;
  const { baseSlug, effort, speed } = peelEffortAndSpeedSuffixes(mapped);

  if (baseSlug && baseSlug !== mapped) {
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

  const searchSlug = baseSlug || mapped;
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
      model: { id: mapped, name: mapped, supportsImages: true },
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

function normalizeEffortValue(raw: string | null | undefined): ThoughtLevel | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase().replaceAll("-", "_");
  if (norm === "none" || norm === "off") return "none";
  if (norm === "minimal") return "minimal";
  if (norm === "low") return "low";
  if (norm === "medium") return "medium";
  if (norm === "high" || norm === "on") return "high";
  if (norm === "xhigh" || norm === "extra_high" || norm === "very_high") return "xhigh";
  if (norm === "max") return "max";
  return null;
}

/**
 * Pick the nearest supported effort level on the ordered scale for a specific Devin model.
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
 * Resolve ACP thought_level from model suffix, Anthropic output_config.effort, thinking config, and proxy defaults.
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
  return 262_144;
}

/**
 * Format Devin model list as Anthropic GET /v1/models payload with metadata for client pickers.
 */
export function formatAnthropicModelsList(
  catalogModels: readonly DevinModelEntry[],
  defaultModel: string,
): AnthropicModelsListResponse {
  const list: readonly DevinModelEntry[] =
    catalogModels.length > 0
      ? catalogModels
      : [{ id: defaultModel, name: defaultModel, supportsImages: true }];

  const data: AnthropicModelInfo[] = list.map((model) => {
    const line = inferModelLine(model.id);
    return {
      type: "model",
      id: model.id,
      display_name: model.name,
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
