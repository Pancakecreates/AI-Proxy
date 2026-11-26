import type {
  AcpConfigGroupOption,
  AcpConfigOption,
  AcpConfigSelectOption,
  AnthropicModelInfo,
  AnthropicModelLine,
  AnthropicModelsListResponse,
  AnthropicThinkingConfig,
  ConfigCatalog,
  DevinMode,
  DevinModelEntry,
  ThoughtLevel,
} from "./types.js";

const CREATED_AT_ISO = "2026-01-01T00:00:00Z";

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
      result.currentSpeed = typeof option.currentValue === "string" ? option.currentValue : null;
      result.speeds = entries.map((entry) => entry.value);
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
 * Map an Anthropic or user-supplied model string to a Devin ACP model id.
 */
export function resolveDevinModel(
  requestedModel: string | undefined,
  catalogModels: readonly DevinModelEntry[],
  options: { defaultModel?: string; modelMap?: Record<string, string> } = {},
): DevinModelEntry {
  const defaultModel = options.defaultModel ?? "swe-2-1-medium";
  const modelMap = options.modelMap ?? {};

  const raw = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const mappedRaw = (raw && (modelMap[raw] ?? modelMap[raw.toLowerCase()])) || raw;

  if (!mappedRaw) {
    return (
      findCatalogModel(defaultModel, catalogModels) ?? {
        id: defaultModel,
        name: defaultModel,
        supportsImages: true,
      }
    );
  }

  const candidates = [mappedRaw];
  if (/\[1m\]$/i.test(mappedRaw)) {
    const stripped = mappedRaw.replace(/\[1m\]$/i, "").trim();
    candidates.push(`${stripped}-1m`, stripped);
  }

  for (const candidate of candidates) {
    const exact = findCatalogModel(candidate, catalogModels);
    if (exact) return exact;
  }

  const mapped = candidates[candidates.length - 1] ?? mappedRaw;
  const lower = mapped.toLowerCase();

  if (lower.includes("haiku")) {
    const haiku = findBestMatch(catalogModels, (m) => m.id.includes("haiku") && !m.id.includes("fusion"));
    if (haiku) return haiku;
  }
  if (lower.includes("sonnet")) {
    const sonnet = findBestMatch(catalogModels, (m) => m.id.includes("sonnet") && !m.id.includes("fusion"));
    if (sonnet) return sonnet;
  }
  if (lower.includes("opus")) {
    const opus = findBestMatch(catalogModels, (m) => m.id.includes("opus") && !m.id.includes("fusion"));
    if (opus) return opus;
  }
  if (lower.includes("fable")) {
    const fable = findBestMatch(catalogModels, (m) => m.id.includes("fable") && !m.id.includes("fusion"));
    if (fable) return fable;
  }

  const norm = normalizeSlug(lower);
  const fuzzy = findBestMatch(
    catalogModels,
    (m) => !m.id.includes("fusion") && (normalizeSlug(m.id).includes(norm) || normalizeSlug(m.name).includes(norm)),
  );
  if (fuzzy) return fuzzy;

  if (catalogModels.length === 0) {
    return { id: mapped, name: mapped, supportsImages: true };
  }

  return findCatalogModel(defaultModel, catalogModels) ?? catalogModels[0]!;
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

/**
 * Resolve ACP thought_level from Anthropic `thinking` config + proxy defaults.
 */
export function resolveThoughtLevel(
  thinkingParam: AnthropicThinkingConfig | undefined,
  defaultThoughtLevel: ThoughtLevel | null,
  supportedLevels: readonly ThoughtLevel[],
): ThoughtLevel | null {
  let desired = defaultThoughtLevel;
  if (thinkingParam && typeof thinkingParam === "object") {
    if (thinkingParam.type === "disabled") {
      desired = "medium";
    } else if (thinkingParam.type === "enabled" || thinkingParam.type === "adaptive") {
      const budget = Number(thinkingParam.budget_tokens);
      desired = Number.isFinite(budget) && budget >= 16_000 ? "max" : "high";
    }
  }
  if (!desired) return null;
  if (supportedLevels.length > 0 && !supportedLevels.includes(desired)) {
    return supportedLevels[0] ?? null;
  }
  return desired;
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
