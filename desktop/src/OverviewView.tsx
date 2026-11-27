import React, { useState } from "react";
import { Check, Copy, RefreshCw, Terminal, ArrowUpRight } from "lucide-react";
import type { AppSettings, ProxyRuntimeStatus, UsageSummary } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Badge, Button, Panel, PanelHeader, PanelTitle } from "./components/ui";

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
    status?.openaiUrl ?? `http://${settings.host}:${settings.openaiPort}/v1`;

  const totalTokens = (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0);

  return (
    <div className="flex flex-col gap-5 p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-balance">Панель шлюзов</h1>
          <p className="text-xs text-[var(--fg-muted)] text-pretty mt-0.5">
            Локальный маршрутизатор Anthropic Messages API и OpenAI Chat и Responses API поверх локальных CLI.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onWarmUp} disabled={warmingUp}>
          <RefreshCw className={`size-3.5 ${warmingUp ? "animate-spin" : ""}`} />
          <span>Обновить модели</span>
        </Button>
      </div>

      {status?.lastError && (
        <div className="rounded-[9px] border border-[var(--danger)]/35 bg-[var(--danger-soft)] px-4 py-2.5 text-xs text-[var(--danger)]">
          Ошибка запуска: {status.lastError}
        </div>
      )}

      <Panel className="overflow-hidden">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x">
          <div className="p-4">
            <div className="text-[11px] font-medium text-[var(--fg-muted)]">Моделей активно</div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
              {status?.modelsCount ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Активных сессий: {status?.activeSessions ?? 0}
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] font-medium text-[var(--fg-muted)]">Запросов (30 дн.)</div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
              {usage?.totalRequests ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Измерено: {usage?.measuredCount ?? 0} · Оценка: {usage?.estimatedCount ?? 0}
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] font-medium text-[var(--fg-muted)]">Расходы</div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
              ${(usage?.totalCostUsd ?? 0).toFixed(2)}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Эквивалент API: ~${(usage?.totalApiEquivalentUsd ?? 0).toFixed(2)}
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] font-medium text-[var(--fg-muted)]">Токены и задержка</div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
              {totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Средний ответ: {Math.round(usage?.avgLatencyMs ?? 0)} мс
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <BrandIcon brand="claude" size={20} />
              <div>
                <div className="text-[13px] font-semibold tracking-[-0.01em]">Anthropic Gateway</div>
                <div className="text-[11px] text-[var(--fg-muted)]">Claude Desktop & Claude Code</div>
              </div>
            </div>
            <Badge
              variant={status?.running && settings.enableAnthropic ? "success" : "subtle"}
              className="rounded-full px-2"
            >
              {status?.running && settings.enableAnthropic ? "Слушает" : "Выкл"}
            </Badge>
          </div>

          <div className="flex items-center justify-between rounded-[7px] border bg-[var(--bg)] px-3 py-1.5 text-xs tabular-nums">
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

          <div className="rounded-[7px] border bg-[var(--bg)] p-2.5 text-[11px] text-[var(--fg-muted)] space-y-1">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[var(--fg)] font-sans font-medium">
                <Terminal className="size-3 text-[var(--fg-subtle)]" /> Claude Code (~/.claude/settings.json)
              </span>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    "cc-cmd",
                    `ANTHROPIC_BASE_URL=${anthropicUrl}\nANTHROPIC_AUTH_TOKEN=${settings.apiKey || "local-proxy"}`
                  )
                }
                className="text-[11px] font-sans font-medium text-[var(--accent)] hover:underline"
              >
                {copied === "cc-cmd" ? "Готово" : "Копировать"}
              </button>
            </div>
            <div className="truncate">ANTHROPIC_BASE_URL={anthropicUrl}</div>
            <div className="truncate">ANTHROPIC_AUTH_TOKEN={settings.apiKey || "local-proxy"}</div>
          </div>
        </Panel>

        <Panel className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <BrandIcon brand="openai" size={20} />
              <div>
                <div className="text-[13px] font-semibold tracking-[-0.01em]">OpenAI & Codex Gateway</div>
                <div className="text-[11px] text-[var(--fg-muted)]">/v1/chat/completions и /v1/responses</div>
              </div>
            </div>
            <Badge
              variant={status?.running && settings.enableOpenai ? "success" : "subtle"}
              className="rounded-full px-2"
            >
              {status?.running && settings.enableOpenai ? "Слушает" : "Выкл"}
            </Badge>
          </div>

          <div className="flex items-center justify-between rounded-[7px] border bg-[var(--bg)] px-3 py-1.5 text-xs tabular-nums">
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

          <div className="rounded-[7px] border bg-[var(--bg)] p-2.5 text-[11px] text-[var(--fg-muted)] space-y-1">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[var(--fg)] font-sans font-medium">
                <Terminal className="size-3 text-[var(--fg-subtle)]" /> Codex CLI и OpenAI SDK
              </span>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    "oai-cmd",
                    `OPENAI_BASE_URL=${openaiUrl}\nOPENAI_API_KEY=${settings.apiKey || "local-proxy"}`
                  )
                }
                className="text-[11px] font-sans font-medium text-[var(--accent)] hover:underline"
              >
                {copied === "oai-cmd" ? "Готово" : "Копировать"}
              </button>
            </div>
            <div className="truncate">OPENAI_BASE_URL={openaiUrl}</div>
            <div className="truncate">OPENAI_API_KEY={settings.apiKey || "local-proxy"}</div>
          </div>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <PanelTitle>Активные бэкенды</PanelTitle>
          <button
            type="button"
            onClick={() => onNavigate("accounts")}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
          >
            <span>Аккаунты и лимиты</span>
            <ArrowUpRight className="size-3.5" />
          </button>
        </PanelHeader>
        <div className="divide-y">
          {(status?.backends ?? []).length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--fg-muted)]">
              Бэкенды не запущены. Нажмите «Старт» в верхней панели или проверьте пути CLI в разделе «Аккаунты и CLI».
            </div>
          ) : (
            status?.backends.map((b) => (
              <div
                key={b.key}
                className="flex items-center justify-between gap-3 px-4 py-[var(--density-cell-y)] text-xs hover:bg-[var(--bg-subtle)]/40 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <BrandIcon brand={b.kind} size={18} />
                  <div className="min-w-0">
                    <div className="font-medium truncate text-[var(--fg)]">{b.label}</div>
                    <div className="text-[11px] text-[var(--fg-subtle)] truncate">
                      {b.error ? b.error : b.executable || b.key}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 tabular-nums">
                  <span className="text-[var(--fg-muted)]">{b.modelsCount} мод.</span>
                  <span className="text-[var(--fg-subtle)]">сессий: {b.activeSessions}</span>
                  <Badge
                    variant={b.error ? "danger" : b.ready ? "success" : "subtle"}
                    className="rounded-full px-2"
                  >
                    {b.error ? "Ошибка" : b.ready ? "Готов" : "Спит"}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
};
