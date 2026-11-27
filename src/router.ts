import {
  decodeGatewayModelId,
  peelEffortAndSpeedSuffixes,
  resolveDevinModelWithHints,
} from "./models.js";
import type {
  AnthropicMessagesRequest,
  BackendHealthStatus,
  BackendModelEntry,
  ProxyBackend,
  ProxyConfig,
  RunTurnCallbacks,
  SpeedMode,
  ThoughtLevel,
  TurnResult,
} from "./types.js";

export interface RoutedTarget {
  backend: ProxyBackend;
  nativeModelId: string;
  requestedEffort: ThoughtLevel | null;
  requestedSpeed: SpeedMode | null;
}

function lookupModelMap(raw: string, modelMap: Record<string, string>): string | undefined {
  if (!raw) return undefined;
  return modelMap[raw] ?? modelMap[raw.toLowerCase()];
}

function splitQualifiedId(slug: string): { prefix: string; rest: string } | null {
  if (slug.startsWith("agy-")) {
    const dot = slug.indexOf(".", 4);
    if (dot > 4) {
      return { prefix: slug.slice(0, dot + 1), rest: slug.slice(dot + 1) };
    }
  }
  if (slug.startsWith("agy:")) {
    const secondColon = slug.indexOf(":", 4);
    if (secondColon > 4) {
      return { prefix: slug.slice(0, secondColon + 1), rest: slug.slice(secondColon + 1) };
    }
  }
  for (const prefix of ["oc-go.", "oc-free.", "oc.", "grok.", "codex.", "oc:", "grok:", "codex:"]) {
    if (slug.startsWith(prefix)) {
      return { prefix, rest: slug.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Coordinates multiple AI backends (Devin, Antigravity accounts, OpenCode, Grok, Codex)
 * behind a unified Anthropic /v1/models and /v1/messages surface.
 */
export class BackendRouter {
  readonly #backends: ProxyBackend[];
  readonly #config: ProxyConfig;
  #warmupPromise: Promise<BackendModelEntry[]> | null = null;

  constructor(backends: ProxyBackend[], config: ProxyConfig) {
    this.#backends = backends;
    this.#config = config;
  }

  get backends(): readonly ProxyBackend[] {
    return this.#backends;
  }

  get activeSessionCount(): number {
    return this.#backends.reduce((sum, b) => sum + b.activeSessionCount, 0);
  }

  get isAnyReady(): boolean {
    return this.#backends.some((b) => b.isReady);
  }

  async warmUp(force = false): Promise<BackendModelEntry[]> {
    if (!force && this.listModels().length > 0) {
      return this.listModels();
    }
    if (this.#warmupPromise) return this.#warmupPromise;

    this.#warmupPromise = (async () => {
      const results = await Promise.allSettled(this.#backends.map((b) => b.warmUp(force)));
      const models = this.listModels();
      if (models.length === 0) {
        const firstErr = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
        if (firstErr) throw firstErr;
      }
      return models;
    })().finally(() => {
      this.#warmupPromise = null;
    });

    return this.#warmupPromise;
  }

  listModels(): BackendModelEntry[] {
    return this.#backends.flatMap((b) => b.listModels());
  }

  getHealthStatuses(): BackendHealthStatus[] {
    return this.#backends.map((b) => b.getStatus());
  }

  resolveTarget(requestedModel: string | undefined): RoutedTarget {
    const allModels = this.listModels();
    const backendByKey = new Map(this.#backends.map((b) => [b.key, b]));

    const raw = typeof requestedModel === "string" ? requestedModel.trim() : "";
    const strippedRaw1m = raw.replace(/\[1m\]$/i, "").trim();
    const mappedRaw =
      lookupModelMap(raw, this.#config.modelMap) ??
      (strippedRaw1m !== raw ? lookupModelMap(strippedRaw1m, this.#config.modelMap) : undefined) ??
      raw;

    if (!mappedRaw) {
      const devin = this.#backends.find((b) => b.kind === "devin") ?? this.#backends[0];
      if (!devin) throw new Error("No AI backends are enabled.");
      return {
        backend: devin,
        nativeModelId: this.#config.defaultModel,
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
      const decoded = decodeGatewayModelId(candidate);
      const probes = decoded ? [candidate, decoded] : [candidate];
      for (const probe of probes) {
        const exactQualified = allModels.find((m) => m.qualifiedId === probe || m.qualifiedId.toLowerCase() === probe.toLowerCase());
        if (exactQualified) {
          const backend = backendByKey.get(exactQualified.backendKey);
          if (backend) {
            return {
              backend,
              nativeModelId: exactQualified.nativeId,
              requestedEffort: null,
              requestedSpeed: null,
            };
          }
        }
      }
    }

    const lastCandidate = candidates[candidates.length - 1] ?? mappedRaw;
    const effectiveSlug = decodeGatewayModelId(lastCandidate) ?? lastCandidate;
    const qualifiedParts = splitQualifiedId(effectiveSlug);

    if (qualifiedParts) {
      const { prefix, rest } = qualifiedParts;
      const { baseSlug, effort, speed } = peelEffortAndSpeedSuffixes(rest);
      const scopedModels = allModels.filter((m) => m.qualifiedId.startsWith(prefix));
      const matched =
        scopedModels.find((m) => m.nativeId === rest || m.nativeId.toLowerCase() === rest.toLowerCase()) ??
        scopedModels.find((m) => m.nativeId === baseSlug || m.nativeId.toLowerCase() === baseSlug.toLowerCase());
      if (matched) {
        const backend = backendByKey.get(matched.backendKey);
        if (backend) {
          return {
            backend,
            nativeModelId: matched.nativeId,
            requestedEffort: matched.nativeId.toLowerCase() === rest.toLowerCase() ? null : effort,
            requestedSpeed: matched.nativeId.toLowerCase() === rest.toLowerCase() ? null : speed,
          };
        }
      }
    }

    const { baseSlug, effort, speed } = peelEffortAndSpeedSuffixes(effectiveSlug);
    for (const probe of [effectiveSlug, baseSlug]) {
      if (!probe) continue;
      const exactNative = allModels.find(
        (m) => m.nativeId === probe || m.nativeId.toLowerCase() === probe.toLowerCase(),
      );
      if (exactNative) {
        const backend = backendByKey.get(exactNative.backendKey);
        if (backend) {
          const isExact = probe === effectiveSlug;
          return {
            backend,
            nativeModelId: exactNative.nativeId,
            requestedEffort: isExact ? null : effort,
            requestedSpeed: isExact ? null : speed,
          };
        }
      }
    }

    const devinBackend = this.#backends.find((b) => b.kind === "devin");
    if (devinBackend) {
      const devinModels = devinBackend.listModels();
      const selection = resolveDevinModelWithHints(requestedModel, devinModels, {
        defaultModel: this.#config.defaultModel,
        modelMap: this.#config.modelMap,
      });
      return {
        backend: devinBackend,
        nativeModelId: selection.model.id,
        requestedEffort: selection.requestedEffort,
        requestedSpeed: selection.requestedSpeed,
      };
    }

    const fallbackBackend = this.#backends[0];
    if (!fallbackBackend) throw new Error("No AI backends are enabled.");
    const fallbackModels = fallbackBackend.listModels();
    const selection = resolveDevinModelWithHints(requestedModel, fallbackModels, {
      defaultModel: fallbackModels[0]?.nativeId ?? this.#config.defaultModel,
      modelMap: this.#config.modelMap,
    });
    return {
      backend: fallbackBackend,
      nativeModelId: selection.model.id,
      requestedEffort: selection.requestedEffort,
      requestedSpeed: selection.requestedSpeed,
    };
  }

  async runTurn(request: AnthropicMessagesRequest, callbacks: RunTurnCallbacks): Promise<TurnResult> {
    if (this.listModels().length === 0) {
      await this.warmUp();
    }
    const target = this.resolveTarget(request.model);
    return target.backend.runTurn(target.nativeModelId, request, callbacks, {
      requestedEffort: target.requestedEffort,
      requestedSpeed: target.requestedSpeed,
    });
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.#backends.map((b) => b.closeAll()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.#backends.map((b) => b.shutdown()));
  }
}
