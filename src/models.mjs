const CREATED_AT_ISO = "2026-01-01T00:00:00Z";

/**
 * Extract structured model, mode, thought_level, and speed catalogs from ACP configOptions.
 */
export function parseConfigCatalog(configOptions) {
  const result = {
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
      result.currentMode = typeof option.currentValue === "string" ? option.currentValue : null;
      result.modes = entries.map((entry) => entry.value);
    } else if (option.id === "thought_level") {
      result.currentThoughtLevel = typeof option.currentValue === "string" ? option.currentValue : null;
      result.thoughtLevels = entries.map((entry) => entry.value);
    } else if (option.id === "speed") {
      result.currentSpeed = typeof option.currentValue === "string" ? option.currentValue : null;
      result.speeds = entries.map((entry) => entry.value);
    }
  }
  return result;
}

function flattenSelectOptions(options) {
  if (!Array.isArray(options)) return [];
  const flat = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (nested && typeof nested === "object" && typeof nested.value === "string") flat.push(nested);
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
export function resolveDevinModel(requestedModel, catalogModels, { defaultModel = "swe-2-1-medium", modelMap = {} } = {}) {
  const raw = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const mappedRaw = (raw && (modelMap[raw] ?? modelMap[raw.toLowerCase()])) || raw;

  if (!mappedRaw) {
    return findCatalogModel(defaultModel, catalogModels) ?? { id: defaultModel, name: defaultModel, supportsImages: true };
  }

  // Handle Claude Desktop 1M-context UI variants like "model-id[1m]"
  const candidates = [mappedRaw];
  if (/\[1m\]$/i.test(mappedRaw)) {
    const stripped = mappedRaw.replace(/\[1m\]$/i, "").trim();
    candidates.push(`${stripped}-1m`, stripped);
  }

  for (const candidate of candidates) {
    const exact = findCatalogModel(candidate, catalogModels);
    if (exact) return exact;
  }

  const mapped = candidates[candidates.length - 1];
  const lower = mapped.toLowerCase();

  // Map standard Anthropic Claude API model ids (e.g. claude-3-5-haiku-20241022, claude-sonnet-4-5)
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

  // Fuzzy prefix/substring match against Devin catalog (e.g. "deepseek", "gemini-4", "gpt-6.2", "swe")
  const norm = normalizeSlug(lower);
  const fuzzy = findBestMatch(
    catalogModels,
    (m) => !m.id.includes("fusion") && (normalizeSlug(m.id).includes(norm) || normalizeSlug(m.name).includes(norm)),
  );
  if (fuzzy) return fuzzy;

  if (catalogModels.length === 0) {
    return { id: mapped, name: mapped, supportsImages: true };
  }

  return findCatalogModel(defaultModel, catalogModels) ?? catalogModels[0];
}

function findCatalogModel(candidate, models) {
  if (!candidate || !Array.isArray(models) || models.length === 0) return null;
  const lower = candidate.toLowerCase();
  return (
    models.find((m) => m.id === candidate) ??
    models.find((m) => m.id.toLowerCase() === lower) ??
    models.find((m) => m.name.toLowerCase() === lower) ??
    null
  );
}

function findBestMatch(models, predicate) {
  const candidates = models.filter(predicate);
  if (candidates.length === 0) return null;
  return (
    candidates.find((m) => m.id.endsWith("-medium")) ??
    candidates.find((m) => m.id.endsWith("-high")) ??
    candidates[0]
  );
}

function normalizeSlug(value) {
  return value.toLowerCase().replace(/[.\s_]+/g, "-");
}

/**
 * Resolve ACP thought_level from Anthropic `thinking` config + proxy defaults.
 */
export function resolveThoughtLevel(thinkingParam, defaultThoughtLevel, supportedLevels) {
  let desired = defaultThoughtLevel;
  if (thinkingParam && typeof thinkingParam === "object") {
    if (thinkingParam.type === "disabled") {
      desired = "medium";
    } else if (thinkingParam.type === "enabled" || thinkingParam.type === "adaptive") {
      const budget = Number(thinkingParam.budget_tokens);
      if (Number.isFinite(budget) && budget >= 16_000) desired = "max";
      else desired = "high";
    }
  }
  if (!desired) return null;
  if (Array.isArray(supportedLevels) && supportedLevels.length > 0 && !supportedLevels.includes(desired)) {
    return supportedLevels[0];
  }
  return desired;
}

/**
 * Format Devin model list as Anthropic GET /v1/models payload.
 */
export function formatAnthropicModelsList(catalogModels, defaultModel) {
  const list =
    catalogModels.length > 0
      ? catalogModels
      : [{ id: defaultModel, name: defaultModel, supportsImages: true }];

  const data = list.map((model) => ({
    type: "model",
    id: model.id,
    display_name: model.name,
    created_at: CREATED_AT_ISO,
  }));

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
