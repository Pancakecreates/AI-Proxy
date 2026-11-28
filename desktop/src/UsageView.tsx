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
import {
  Button,
  PageHeader,
  Panel,
  PanelHeader,
  PanelTitle,
  Segmented,
  Stat,
  StatGrid,
} from "./components/ui";
import { formatDuration, formatTokens } from "./format";
import { useI18n } from "./i18n";

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
  const { t } = useI18n();
  const [days, setDays] = useState<"7" | "30" | "90">("30");

  const handleDays = (d: "7" | "30" | "90") => {
    setDays(d);
    onReload(Number(d));
  };

  const maxDayTokens = Math.max(
    1,
    ...(usage?.byDay.map((d) => d.inputTokens + d.outputTokens) ?? [1]),
  );

  const totalTokens = (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0);

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <PageHeader
          title={t("Траты и токены")}
          description={t("Точный подсчёт из ответов CLI и оценка по символам там, где CLI не отдаёт usage.")}
        >
          <Segmented
            value={days}
            onChange={handleDays}
            options={[
              { value: "7", label: t("7 дн.") },
              { value: "30", label: t("30 дн.") },
              { value: "90", label: t("90 дн.") },
            ]}
          />
          <Button
            variant="secondary"
            size="icon"
            onClick={() => onReload(Number(days))}
            title={t("Обновить")}
            aria-label={t("Обновить статистику")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </PageHeader>

        <StatGrid>
          <Stat
            label={t("Списано за токены")}
            value={`$${(usage?.totalCostUsd ?? 0).toFixed(4)}`}
            sub={t("Провайдеры с оплатой за токен; подписки и бесплатные CLI без списаний")}
          />
          <Stat
            label={t("Оценка в ценах API")}
            value={`~$${(usage?.totalApiEquivalentUsd ?? 0).toFixed(4)}`}
            sub={t("Расчётный эквивалент по публичным тарифам")}
          />
          <Stat
            label={t("Токены")}
            value={formatTokens(totalTokens)}
            sub={
              <>
                {t("вход")} {formatTokens(usage?.totalInputTokens ?? 0)} · {t("выход")}{" "}
                {formatTokens(usage?.totalOutputTokens ?? 0)}
                <br />
                {t("кеш")}{" "}
                {(usage?.totalCacheReadTokens ?? 0) > 0
                  ? formatTokens(usage?.totalCacheReadTokens ?? 0)
                  : "—"}{" "}
                · {t("рассуждения")} {formatTokens(usage?.totalThinkingTokens ?? 0)}
              </>
            }
          />
          <Stat
            label={t("Точность измерений")}
            value={`${usage?.measuredCount ?? 0} / ${usage?.totalRequests ?? 0}`}
            sub={t("Средняя задержка {duration}", { duration: formatDuration(usage?.avgLatencyMs ?? 0) })}
          />
        </StatGrid>

        <Panel className="overflow-hidden">
          <PanelHeader>
            <PanelTitle>{t("Токены по дням")}</PanelTitle>
            <span className="text-[11px] text-[var(--fg-subtle)] tabular-nums">
              {t("пик {peak} за день", { peak: formatTokens(maxDayTokens) })}
            </span>
          </PanelHeader>
          <div className="p-4">
            {(usage?.byDay.length ?? 0) === 0 ? (
              <div className="py-10 text-center text-[12px] text-[var(--fg-muted)]">
                {t("За выбранный период запросов пока нет.")}
              </div>
            ) : (
              <div className="flex h-32 items-end gap-1">
                {usage!.byDay.map((d) => {
                  const total = d.inputTokens + d.outputTokens;
                  const pct = Math.max(3, Math.round((total / maxDayTokens) * 100));
                  return (
                    <div key={d.key} className="group flex h-full min-w-0 flex-1 flex-col items-center gap-1.5">
                      <div className="flex w-full min-h-0 flex-1 items-end justify-center">
                        <div
                          title={t("{label}: {tokens} токенов (${cost} API экв.)", { label: d.label, tokens: total.toLocaleString(), cost: d.apiEquivalentUsd.toFixed(4) })}
                          style={{ height: `${pct}%` }}
                          className="w-full max-w-[26px] rounded-[2px] bg-[var(--accent)] opacity-55 transition-opacity group-hover:opacity-100"
                        />
                      </div>
                      <span className="w-full truncate text-center text-[11px] tabular-nums text-[var(--fg-subtle)]">
                        {d.label.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>{t("По аккаунтам")}</PanelTitle>
            </PanelHeader>
            <div className="overflow-x-auto">
              <table className="data-table tabular-nums">
                <thead>
                  <tr>
                    <th>{t("Аккаунт")}</th>
                    <th className="text-right">{t("Запросов")}</th>
                    <th className="text-right">{t("Токенов")}</th>
                    <th className="text-right">{t("Оценка API")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(usage?.byBackend ?? []).map((b) => {
                    const acc = resolveAccountInfo({
                      backendKey: b.key === "unknown" ? null : b.key,
                      accountLabel: b.label === b.key ? null : b.label,
                      backends,
                      antigravityAccounts,
                      customAcpAgents,
                    });
                    return (
                      <tr key={b.key}>
                        <td>
                          <div className="flex min-w-0 items-center gap-2">
                            {acc.key && <BrandIcon brand={acc.brand} size={14} />}
                            <span className="truncate font-medium text-[var(--fg)]">
                              {b.key === "unknown" ? t("Не маршрутизирован") : acc.title}
                            </span>
                          </div>
                        </td>
                        <td className="text-right text-[var(--fg-muted)]">{b.requests}</td>
                        <td className="text-right text-[var(--fg-muted)]">
                          {formatTokens(b.inputTokens + b.outputTokens)}
                        </td>
                        <td className="text-right text-[var(--fg-subtle)]">
                          ~${b.apiEquivalentUsd.toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>{t("Топ моделей")}</PanelTitle>
            </PanelHeader>
            <div className="overflow-x-auto">
              <table className="data-table tabular-nums">
                <thead>
                  <tr>
                    <th>{t("Модель")}</th>
                    <th className="text-right">{t("Запросов")}</th>
                    <th className="text-right">{t("Токенов")}</th>
                    <th className="text-right">{t("Оценка API")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(usage?.byModel ?? []).map((m) => (
                    <tr key={m.key}>
                      <td className="max-w-[220px] truncate text-[11px] text-[var(--fg)]">{m.label}</td>
                      <td className="text-right text-[var(--fg-muted)]">{m.requests}</td>
                      <td className="text-right text-[var(--fg-muted)]">
                        {formatTokens(m.inputTokens + m.outputTokens)}
                      </td>
                      <td className="text-right text-[var(--fg-subtle)]">
                        ~${m.apiEquivalentUsd.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
};
