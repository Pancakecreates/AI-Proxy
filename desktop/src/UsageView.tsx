import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  AntigravityAccountConfig,
  BackendHealthStatus,
  CustomAcpAgentConfig,
  UsageSummary,
} from "./types";
import { BrandIcon } from "./BrandIcon";
import { resolveAccountInfo } from "./backendDisplay";
import { Button, Panel, PanelHeader, PanelTitle, Segmented } from "./components/ui";
import { formatDuration, formatTokens } from "./format";

interface UsageViewProps {
  usage: UsageSummary | null;
  backends?: BackendHealthStatus[];
  antigravityAccounts?: AntigravityAccountConfig[];
  customAcpAgents?: CustomAcpAgentConfig[];
  onReload: (days: number) => void;
}

export const UsageView: React.FC<UsageViewProps> = ({
  usage,
  backends = [],
  antigravityAccounts = [],
  customAcpAgents = [],
  onReload,
}) => {
  const [days, setDays] = useState<"7" | "30" | "90">("30");

  const handleDays = (d: "7" | "30" | "90") => {
    setDays(d);
    onReload(Number(d));
  };

  const maxDayTokens = Math.max(
    1,
    ...(usage?.byDay.map((d) => d.inputTokens + d.outputTokens) ?? [1]),
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.02em]">Траты и расход токенов</h1>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5">
              Точный подсчёт токенов из ответов CLI и оценка по символам там, где CLI не отдаёт usage.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              value={days}
              onChange={handleDays}
              options={[
                { value: "7", label: "7 дн." },
                { value: "30", label: "30 дн." },
                { value: "90", label: "90 дн." },
              ]}
            />
            <Button
              variant="secondary"
              size="icon"
              onClick={() => onReload(Number(days))}
              title="Обновить"
              aria-label="Обновить статистику"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        <Panel className="overflow-hidden">
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x">
            <div className="p-4">
              <div className="text-[11px] font-medium text-[var(--fg-muted)]">Списано за токены</div>
              <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
                ${(usage?.totalCostUsd ?? 0).toFixed(4)}
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                Только провайдеры с оплатой за токен; подписки и бесплатные CLI — без списаний
              </div>
            </div>

            <div className="p-4">
              <div className="text-[11px] font-medium text-[var(--fg-muted)]">Оценка в ценах API</div>
              <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums text-[var(--accent)]">
                ~${(usage?.totalApiEquivalentUsd ?? 0).toFixed(4)}
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                Расчётный эквивалент по публичным тарифам
              </div>
            </div>

            <div className="p-4">
              <div className="text-[11px] font-medium text-[var(--fg-muted)]">Токены</div>
              <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
                {formatTokens(usage?.totalInputTokens ?? 0)} вх. ·{" "}
                {formatTokens(usage?.totalOutputTokens ?? 0)} исх.
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
                Кеш: {(usage?.totalCacheReadTokens ?? 0) > 0 ? formatTokens(usage?.totalCacheReadTokens ?? 0) : "—"}
                {" · "}Рассуждения: {formatTokens(usage?.totalThinkingTokens ?? 0)}
              </div>
            </div>

            <div className="p-4">
              <div className="text-[11px] font-medium text-[var(--fg-muted)]">Точность измерений</div>
              <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
                {usage?.measuredCount ?? 0} из {usage?.totalRequests ?? 0}
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
                Средняя задержка: {formatDuration(usage?.avgLatencyMs ?? 0)}
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="p-4">
          <h2 className="text-[13px] font-semibold tracking-[-0.01em] mb-3">Динамика токенов по дням</h2>
          {(usage?.byDay.length ?? 0) === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--fg-muted)]">
              За выбранный период запросов пока нет.
            </div>
          ) : (
            <div className="flex items-end gap-1.5 h-36 pt-2">
              {usage!.byDay.map((d) => {
                const total = d.inputTokens + d.outputTokens;
                const pct = Math.max(4, Math.round((total / maxDayTokens) * 100));
                return (
                  <div key={d.key} className="flex-1 h-full flex flex-col items-center gap-1 min-w-0 group">
                    <div className="w-full flex-1 min-h-0 flex items-end justify-center">
                      <div
                        title={`${d.label}: ${total.toLocaleString()} токенов ($${d.apiEquivalentUsd.toFixed(4)} API экв.)`}
                        style={{ height: `${pct}%` }}
                        className="w-full max-w-[32px] rounded-t-[4px] bg-[var(--accent)] opacity-80 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                    <span className="text-[10px] text-[var(--fg-subtle)] tabular-nums truncate w-full text-center">
                      {d.label.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>По аккаунтам и бэкендам</PanelTitle>
            </PanelHeader>
            <table className="w-full text-xs text-left border-collapse">
              <thead className="border-b bg-[var(--bg-subtle)]/70 text-[var(--fg-muted)]">
                <tr>
                  <th className="py-2 px-3 font-medium">Аккаунт</th>
                  <th className="py-2 px-3 font-medium text-right">Запросов</th>
                  <th className="py-2 px-3 font-medium text-right">Токенов</th>
                  <th className="py-2 px-3 font-medium text-right">Оценка API</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {(usage?.byBackend ?? []).map((b) => {
                  const acc = resolveAccountInfo({
                    backendKey: b.key === "unknown" ? null : b.key,
                    accountLabel: b.label === b.key ? null : b.label,
                    backends,
                    antigravityAccounts,
                    customAcpAgents,
                  });
                  return (
                    <tr key={b.key} className="hover:bg-[var(--bg-subtle)]/40">
                      <td className="py-[var(--density-cell-y)] px-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {acc.key && <BrandIcon brand={acc.brand} size={14} />}
                          <span className="font-medium truncate">
                            {b.key === "unknown" ? "Не маршрутизирован" : acc.title}
                          </span>
                        </div>
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 text-right">{b.requests}</td>
                      <td className="py-[var(--density-cell-y)] px-3 text-right">
                        {(b.inputTokens + b.outputTokens).toLocaleString()}
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 text-right text-[var(--fg-muted)]">
                        ~${b.apiEquivalentUsd.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Топ моделей</PanelTitle>
            </PanelHeader>
            <table className="w-full text-xs text-left border-collapse">
              <thead className="border-b bg-[var(--bg-subtle)]/70 text-[var(--fg-muted)]">
                <tr>
                  <th className="py-2 px-3 font-medium">Модель</th>
                  <th className="py-2 px-3 font-medium text-right">Запросов</th>
                  <th className="py-2 px-3 font-medium text-right">Токенов</th>
                  <th className="py-2 px-3 font-medium text-right">Оценка API</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {(usage?.byModel ?? []).map((m) => (
                  <tr key={m.key} className="hover:bg-[var(--bg-subtle)]/40">
                    <td className="py-[var(--density-cell-y)] px-3 text-[11px] truncate max-w-[200px]">
                      {m.label}
                    </td>
                    <td className="py-[var(--density-cell-y)] px-3 text-right">{m.requests}</td>
                    <td className="py-[var(--density-cell-y)] px-3 text-right">
                      {(m.inputTokens + m.outputTokens).toLocaleString()}
                    </td>
                    <td className="py-[var(--density-cell-y)] px-3 text-right text-[var(--fg-muted)]">
                      ~${m.apiEquivalentUsd.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
};
