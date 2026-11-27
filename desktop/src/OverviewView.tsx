import React, { useState } from "react";
import {
  Check,
  Copy,
  RefreshCw,
  Terminal,
  Activity,
  Cpu,
  Coins,
  Clock,
  ArrowUpRight,
} from "lucide-react";
import type { AppSettings, ProxyRuntimeStatus, UsageSummary } from "./types";
import { BrandIcon } from "./BrandIcon";

interface OverviewViewProps {
  status: ProxyRuntimeStatus | null;
  settings: AppSettings;
  usage: UsageSummary | null;
  onWarmUp: () => void;
  warmingUp: boolean;
  onNavigate: (tab: string) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  status,
  settings,
  usage,
  onWarmUp,
  warmingUp,
  onNavigate,
}) => {
  const [copied, setCopied] = useState<string | null>(null);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const anthropicUrl = status?.anthropicUrl ?? `http://${settings.host}:${settings.anthropicPort}`;
  const openaiUrl =
    status?.openaiUrl ??
    `http://${settings.host}:${
      settings.openaiPort !== settings.anthropicPort ? settings.openaiPort : settings.anthropicPort
    }/v1`;

  const totalTokens = (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0);

  return (
    <div className="flex flex-col gap-5 p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-balance">Панель шлюзов</h1>
          <p className="text-sm text-[var(--fg-muted)] text-pretty">
            Локальный маршрутизатор Anthropic Messages API и OpenAI Chat/Responses API поверх локальных CLI.
          </p>
        </div>
        <button
          type="button"
          onClick={onWarmUp}
          disabled={warmingUp}
          className="inline-flex h-8 items-center gap-2 rounded-md border bg-[var(--bg-elevated)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${warmingUp ? "animate-spin" : ""}`} />
          <span>Обновить модели</span>
        </button>
      </div>

      {status?.lastError && (
        <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2.5 text-xs text-[var(--danger)]">
          Ошибка запуска: {status.lastError}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-[var(--bg-elevated)] p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--fg-muted)]">
            <span>Моделей активно</span>
            <Cpu className="size-3.5 text-[var(--fg-subtle)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">{status?.modelsCount ?? 0}</div>
          <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)] tabular-nums">
            Активных сессий: {status?.activeSessions ?? 0}
          </div>
        </div>

        <div className="rounded-lg border bg-[var(--bg-elevated)] p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--fg-muted)]">
            <span>Запросов (30 дн.)</span>
            <Activity className="size-3.5 text-[var(--fg-subtle)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">{usage?.totalRequests ?? 0}</div>
          <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)] tabular-nums">
            Измерено точно: {usage?.measuredCount ?? 0} · Оценка: {usage?.estimatedCount ?? 0}
          </div>
        </div>

        <div className="rounded-lg border bg-[var(--bg-elevated)] p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--fg-muted)]">
            <span>Траты / Эквивалент API</span>
            <Coins className="size-3.5 text-[var(--fg-subtle)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">
            ${(usage?.totalCostUsd ?? 0).toFixed(2)}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)] tabular-nums">
            Эквивалент API: ${(usage?.totalApiEquivalentUsd ?? 0).toFixed(2)}
          </div>
        </div>

        <div className="rounded-lg border bg-[var(--bg-elevated)] p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--fg-muted)]">
            <span>Токены и задержка</span>
            <Clock className="size-3.5 text-[var(--fg-subtle)]" />
          </div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums">
            {totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--fg-subtle)] tabular-nums">
            Средний ответ: {Math.round(usage?.avgLatencyMs ?? 0)} мс
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-[var(--bg-elevated)] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <BrandIcon brand="claude" size={20} />
              <div>
                <div className="text-sm font-semibold">Anthropic Gateway</div>
                <div className="text-[11px] text-[var(--fg-muted)]">Claude Desktop & Claude Code</div>
              </div>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status?.running && settings.enableAnthropic
                  ? "bg-[var(--success)]/15 text-[var(--success)]"
                  : "bg-[var(--bg-subtle)] text-[var(--fg-subtle)]"
              }`}
            >
              {status?.running && settings.enableAnthropic ? "Слушает" : "Выкл"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-md border bg-[var(--bg-subtle)] px-3 py-2 font-mono text-xs tabular-nums">
            <span className="truncate">{anthropicUrl}</span>
            <button
              type="button"
              onClick={() => copyText("anth-url", anthropicUrl)}
              className="ml-2 inline-flex items-center gap-1 text-[11px] font-sans font-medium text-[var(--accent)] hover:underline shrink-0"
            >
              {copied === "anth-url" ? <Check className="size-3" /> : <Copy className="size-3" />}
              <span>{copied === "anth-url" ? "Скопировано" : "URL"}</span>
            </button>
          </div>

          <div className="rounded-md border bg-[var(--bg)] p-2.5 font-mono text-[11px] text-[var(--fg-muted)] space-y-1">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[var(--fg)] font-sans font-medium">
                <Terminal className="size-3" /> Claude Code (~/.claude/settings.json)
              </span>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    "cc-cmd",
                    `ANTHROPIC_BASE_URL=${anthropicUrl}\nANTHROPIC_AUTH_TOKEN=${settings.apiKey || "local-proxy"}`
                  )
                }
                className="text-[10px] font-sans text-[var(--accent)] hover:underline"
              >
                {copied === "cc-cmd" ? "Готово" : "Копировать"}
              </button>
            </div>
            <div className="truncate">ANTHROPIC_BASE_URL={anthropicUrl}</div>
            <div className="truncate">ANTHROPIC_AUTH_TOKEN={settings.apiKey || "local-proxy"}</div>
          </div>
        </div>

        <div className="rounded-lg border bg-[var(--bg-elevated)] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <BrandIcon brand="openai" size={20} />
              <div>
                <div className="text-sm font-semibold">OpenAI & Codex Gateway</div>
                <div className="text-[11px] text-[var(--fg-muted)]">
                  /v1/chat/completions & /v1/responses
                </div>
              </div>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status?.running && settings.enableOpenai
                  ? "bg-[var(--success)]/15 text-[var(--success)]"
                  : "bg-[var(--bg-subtle)] text-[var(--fg-subtle)]"
              }`}
            >
              {status?.running && settings.enableOpenai ? "Слушает" : "Выкл"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-md border bg-[var(--bg-subtle)] px-3 py-2 font-mono text-xs tabular-nums">
            <span className="truncate">{openaiUrl}</span>
            <button
              type="button"
              onClick={() => copyText("oai-url", openaiUrl)}
              className="ml-2 inline-flex items-center gap-1 text-[11px] font-sans font-medium text-[var(--accent)] hover:underline shrink-0"
            >
              {copied === "oai-url" ? <Check className="size-3" /> : <Copy className="size-3" />}
              <span>{copied === "oai-url" ? "Скопировано" : "URL"}</span>
            </button>
          </div>

          <div className="rounded-md border bg-[var(--bg)] p-2.5 font-mono text-[11px] text-[var(--fg-muted)] space-y-1">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[var(--fg)] font-sans font-medium">
                <Terminal className="size-3" /> Codex CLI / OpenAI SDK
              </span>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    "oai-cmd",
                    `OPENAI_BASE_URL=${openaiUrl}\nOPENAI_API_KEY=${settings.apiKey || "local-proxy"}`
                  )
                }
                className="text-[10px] font-sans text-[var(--accent)] hover:underline"
              >
                {copied === "oai-cmd" ? "Готово" : "Копировать"}
              </button>
            </div>
            <div className="truncate">OPENAI_BASE_URL={openaiUrl}</div>
            <div className="truncate">OPENAI_API_KEY={settings.apiKey || "local-proxy"}</div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-[var(--bg-elevated)]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Активные бэкенды</h2>
          <button
            type="button"
            onClick={() => onNavigate("accounts")}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
          >
            <span>Аккаунты и лимиты</span>
            <ArrowUpRight className="size-3.5" />
          </button>
        </div>
        <div className="divide-y">
          {(status?.backends ?? []).length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--fg-muted)]">
              Бэкенды не запущены. Нажмите «Старт» в верхней панели или проверьте пути CLI в разделе «Аккаунты и CLI».
            </div>
          ) : (
            status?.backends.map((b) => (
              <div key={b.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  <BrandIcon brand={b.kind} size={18} />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{b.label}</div>
                    <div className="text-[11px] text-[var(--fg-subtle)] truncate font-mono">
                      {b.error ? b.error : b.executable || b.key}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 tabular-nums">
                  <span className="text-[var(--fg-muted)]">{b.modelsCount} мод.</span>
                  <span className="text-[var(--fg-subtle)]">сессий: {b.activeSessions}</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      b.error
                        ? "bg-[var(--danger)]/12 text-[var(--danger)]"
                        : b.ready
                          ? "bg-[var(--success)]/12 text-[var(--success)]"
                          : "bg-[var(--bg-subtle)] text-[var(--fg-muted)]"
                    }`}
                  >
                    {b.error ? "Ошибка" : b.ready ? "Готов" : "Спит"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
