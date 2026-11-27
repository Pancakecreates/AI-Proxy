import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UsageSummary } from "./types";

interface UsageViewProps {
  usage: UsageSummary | null;
  onReload: (days: number) => void;
}

export const UsageView: React.FC<UsageViewProps> = ({ usage, onReload }) => {
  const [days, setDays] = useState(30);

  const handleDays = (d: number) => {
    setDays(d);
    onReload(d);
  };

  const maxDayTokens = Math.max(
    1,
    ...(usage?.byDay.map((d) => d.inputTokens + d.outputTokens) ?? [1])
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Траты и расход токенов</h1>
            <p className="text-xs text-[var(--fg-muted)]">
              Точный подсчёт токенов из ответов CLI (и оценка по символам там, где CLI не отдаёт usage).
            </p>
          </div>
          <div className="flex items-center gap-2">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => handleDays(d)}
                className={`h-8 rounded-md border px-3 text-xs font-medium transition-colors ${
                  days === d
                    ? "bg-[var(--accent)] text-[var(--accent-fg)] border-transparent"
                    : "bg-[var(--bg-elevated)] hover:bg-[var(--bg-subtle)]"
                }`}
              >
                {d} дн.
              </button>
            ))}
            <button
              type="button"
              onClick={() => onReload(days)}
              className="inline-flex h-8 items-center gap-1 rounded-md border bg-[var(--bg-elevated)] px-2.5 text-xs hover:bg-[var(--bg-subtle)]"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border bg-[var(--bg-elevated)] p-4">
            <div className="text-xs text-[var(--fg-muted)]">Списано за токены</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              ${(usage?.totalCostUsd ?? 0).toFixed(4)}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">
              Только провайдеры с оплатой за токен; подписки и бесплатные CLI — без списаний
            </div>
          </div>
          <div className="rounded-lg border bg-[var(--bg-elevated)] p-4">
            <div className="text-xs text-[var(--fg-muted)]">Оценка в ценах API</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-[var(--accent)]">
              ~${(usage?.totalApiEquivalentUsd ?? 0).toFixed(4)}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)]">Расчётный эквивалент по публичным тарифам</div>
          </div>
          <div className="rounded-lg border bg-[var(--bg-elevated)] p-4">
            <div className="text-xs text-[var(--fg-muted)]">Входные / Выходные токены</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {((usage?.totalInputTokens ?? 0) / 1000).toFixed(1)}k / {((usage?.totalOutputTokens ?? 0) / 1000).toFixed(1)}k
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Рассуждения: {((usage?.totalThinkingTokens ?? 0) / 1000).toFixed(1)}k
            </div>
          </div>
          <div className="rounded-lg border bg-[var(--bg-elevated)] p-4">
            <div className="text-xs text-[var(--fg-muted)]">Точность измерений</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {usage?.measuredCount ?? 0} / {usage?.totalRequests ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-[var(--fg-subtle)] tabular-nums">
              Средняя задержка: {Math.round(usage?.avgLatencyMs ?? 0)} мс
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-[var(--bg-elevated)] p-4">
          <h2 className="text-sm font-semibold mb-3">Динамика токенов по дням</h2>
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
                  <div key={d.key} className="flex-1 flex flex-col items-center gap-1 min-w-0 group">
                    <div className="w-full flex-1 flex items-end justify-center">
                      <div
                        title={`${d.label}: ${total.toLocaleString()} токенов ($${d.apiEquivalentUsd.toFixed(4)} API экв.)`}
                        style={{ height: `${pct}%` }}
                        className="w-full max-w-[32px] rounded-t bg-[var(--accent)] opacity-85 group-hover:opacity-100 transition-opacity"
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
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
            <div className="border-b px-4 py-3 text-sm font-semibold">По бэкендам</div>
            <table className="w-full text-xs text-left">
              <thead className="border-b bg-[var(--bg-subtle)] text-[var(--fg-muted)]">
                <tr>
                  <th className="py-2 px-3 font-medium">Бэкенд</th>
                  <th className="py-2 px-3 font-medium text-right">Запросов</th>
                  <th className="py-2 px-3 font-medium text-right">Токенов</th>
                  <th className="py-2 px-3 font-medium text-right">Оценка API</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {(usage?.byBackend ?? []).map((b) => (
                  <tr key={b.key}>
                    <td className="py-2 px-3 font-medium">{b.label}</td>
                    <td className="py-2 px-3 text-right">{b.requests}</td>
                    <td className="py-2 px-3 text-right">{(b.inputTokens + b.outputTokens).toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">~${b.apiEquivalentUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
            <div className="border-b px-4 py-3 text-sm font-semibold">Топ моделей</div>
            <table className="w-full text-xs text-left">
              <thead className="border-b bg-[var(--bg-subtle)] text-[var(--fg-muted)]">
                <tr>
                  <th className="py-2 px-3 font-medium">Модель</th>
                  <th className="py-2 px-3 font-medium text-right">Запросов</th>
                  <th className="py-2 px-3 font-medium text-right">Токенов</th>
                  <th className="py-2 px-3 font-medium text-right">Оценка API</th>
                </tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {(usage?.byModel ?? []).map((m) => (
                  <tr key={m.key}>
                    <td className="py-2 px-3 font-mono text-[11px] truncate max-w-[200px]">{m.label}</td>
                    <td className="py-2 px-3 text-right">{m.requests}</td>
                    <td className="py-2 px-3 text-right">{(m.inputTokens + m.outputTokens).toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">~${m.apiEquivalentUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
