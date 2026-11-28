import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, KeyRound } from "lucide-react";
import type { AppSettings, ProxyRuntimeStatus, UsageSummary } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Button, CopyButton, PageHeader, Panel, PanelHeader, PanelTitle, Stat, StatGrid } from "./components/ui";
import { formatDuration, formatTokens, ruNumber } from "./format";
import { plural, useI18n } from "./i18n";

interface OverviewViewProps {
  status: ProxyRuntimeStatus | null;
  settings: AppSettings;
  usage: UsageSummary | null;
  onWarmUp: () => void;
  warmingUp: boolean;
  onNavigate: (tab: string) => void;
}

function shorten(value: string, head = 12, tail = 5): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

const StatusDot: React.FC<{ on: boolean; label: string; danger?: boolean }> = ({
  on,
  label,
  danger = false,
}) => (
  <span
    className={`inline-flex items-center gap-1.5 text-[11px] ${
      danger ? "text-[var(--danger)]" : "text-[var(--fg-muted)]"
    }`}
  >
    <span
      className={`size-1.5 rounded-full ${
        danger ? "bg-[var(--danger)]" : on ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
      }`}
    />
    {label}
  </span>
);

const CopyRow: React.FC<{
  label: string;
  display: string;
  copyText: string;
  copyTitle: string;
  extra?: React.ReactNode;
}> = ({ label, display, copyText, copyTitle, extra }) => {
  const { t } = useI18n();
  return (
  <div className="kv-row">
    <span className="w-10 shrink-0 text-[11px] font-medium text-[var(--fg-subtle)]">{label}</span>
    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)] tabular-nums">{display}</span>
    {extra}
    <CopyButton iconOnly text={copyText} title={copyTitle} copiedLabel={t("Скопировано")} />
  </div>
  );
};

interface GatewayColumnProps {
  brand: string;
  title: string;
  subtitle: string;
  active: boolean;
  url: string;
  token: string;
  configLines: [string, string];
}

const GatewayColumn: React.FC<GatewayColumnProps> = ({
  brand,
  title,
  subtitle,
  active,
  url,
  token,
  configLines,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandIcon brand={brand} size={22} />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold text-[var(--fg)]">{title}</div>
            <div className="truncate text-[11px] text-[var(--fg-subtle)]">{subtitle}</div>
          </div>
        </div>
        <StatusDot on={active} label={active ? t("работает") : t("выкл")} />
      </div>

      <div className="px-4 pb-1">
        <CopyRow label="URL" display={url} copyText={url} copyTitle={t("Скопировать URL")} />
        <CopyRow
          label={t("Токен")}
          display={shorten(token)}
          copyText={token}
          copyTitle={t("Скопировать токен")}
          extra={<RegenerateTokenButton />}
        />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t bg-[var(--bg-subtle)] px-4 py-2.5">
        <div className="min-w-0 space-y-0.5 text-[11px] leading-relaxed text-[var(--fg-subtle)]">
          <div className="truncate">{configLines[0]}</div>
          <div className="truncate">{configLines[1]}</div>
        </div>
        <CopyButton
          text={configLines.join("\n")}
          label={t("Конфиг")}
          copiedLabel={t("Готово")}
          title={t("Скопировать конфиг")}
        />
      </div>
    </div>
  );
};

const RegenerateTokenButton: React.FC = () => {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirming(false), 3500);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setConfirming(false);
    setBusy(true);
    try {
      await invoke("regenerate_api_key");
    } catch {
      // keep the button usable; errors surface in app logs
    } finally {
      setBusy(false);
    }
  };

  const title = confirming
    ? t("Нажмите ещё раз: старый токен перестанет работать")
    : t("Перегенерировать токен");

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label={title}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        confirming
          ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
          : "border-transparent text-[var(--fg-subtle)] hover:border-[var(--border)] hover:bg-[var(--bg-elevated)] hover:text-[var(--fg)]"
      } ${busy ? "opacity-50" : ""}`}
    >
      <RefreshCw className={`size-3 ${busy ? "animate-spin" : ""}`} />
    </button>
  );
};

export const OverviewView: React.FC<OverviewViewProps> = ({
  status,
  settings,
  usage,
  onWarmUp,
  warmingUp,
  onNavigate,
}) => {
  const { t, lang } = useI18n();

  const anthropicUrl = status?.anthropicUrl ?? `http://${settings.host}:${settings.anthropicPort}`;
  const openaiUrl = status?.openaiUrl ?? `http://${settings.host}:${settings.openaiPort}/v1`;
  const apiToken = settings.apiKey || "local-proxy";

  const inputTokens = usage?.totalInputTokens ?? 0;
  const outputTokens = usage?.totalOutputTokens ?? 0;
  const cacheTokens = usage?.totalCacheReadTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <PageHeader
          title={t("Шлюзы")}
          description={t(
            "Локальный маршрутизатор Anthropic Messages и OpenAI Chat и Responses API поверх локальных CLI.",
          )}
        >
          <Button variant="secondary" size="sm" onClick={onWarmUp} disabled={warmingUp}>
            <RefreshCw className={`size-3.5 ${warmingUp ? "animate-spin" : ""}`} />
            <span>{t("Обновить модели")}</span>
          </Button>
        </PageHeader>

        {status?.lastError && (
          <div className="rounded-[6px] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--danger)]">
            {t("Ошибка запуска")}: {status.lastError}
          </div>
        )}

        <StatGrid>
          <Stat
            label={t("Моделей активно")}
            value={status?.modelsCount ?? 0}
            sub={`${t("Сессий")}: ${status?.activeSessions ?? 0}`}
          />
          <Stat
            label={t("Запросов за 30 дней")}
            value={usage?.totalRequests ?? 0}
            sub={
              <>
                {t("Измерено")} {usage?.measuredCount ?? 0} · {t("оценка")} {usage?.estimatedCount ?? 0}
                <br />
                {t("Средний ответ")} {formatDuration(usage?.avgLatencyMs ?? 0)}
              </>
            }
          />
          <Stat
            label={t("Списано за токены")}
            value={`$${(usage?.totalCostUsd ?? 0).toFixed(2)}`}
            sub={`${t("Эквивалент API")} ~$${(usage?.totalApiEquivalentUsd ?? 0).toFixed(2)}`}
          />
          <Stat
            label={t("Токены")}
            value={formatTokens(totalTokens)}
            valueTitle={ruNumber(totalTokens)}
            sub={
              <>
                {t("вход")} {formatTokens(inputTokens)} · {t("выход")} {formatTokens(outputTokens)}
                <br />
                {t("кеш")} {cacheTokens > 0 ? formatTokens(cacheTokens) : "—"}
              </>
            }
          />
        </StatGrid>

        <Panel className="overflow-hidden">
          <div className="grid grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <GatewayColumn
              brand="claude"
              title="Anthropic Gateway"
              subtitle={t("Claude Desktop и Claude Code")}
              active={Boolean(status?.running && settings.enableAnthropic)}
              url={anthropicUrl}
              token={apiToken}
              configLines={[
                `ANTHROPIC_BASE_URL=${anthropicUrl}`,
                `ANTHROPIC_AUTH_TOKEN=${shorten(apiToken)}`,
              ]}
            />
            <GatewayColumn
              brand="openai"
              title={t("OpenAI и Codex Gateway")}
              subtitle={t("/v1/chat/completions и /v1/responses")}
              active={Boolean(status?.running && settings.enableOpenai)}
              url={openaiUrl}
              token={apiToken}
              configLines={[
                `OPENAI_BASE_URL=${openaiUrl}`,
                `OPENAI_API_KEY=${shorten(apiToken)}`,
              ]}
            />
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader>
            <PanelTitle>{t("Бэкенды")}</PanelTitle>
            <Button variant="ghost" size="xs" onClick={() => onNavigate("accounts")}>
              <KeyRound className="size-3" />
              <span>{t("Аккаунты и лимиты")}</span>
            </Button>
          </PanelHeader>
          <div className="divide-y">
            {(status?.backends ?? []).length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] text-[var(--fg-muted)]">
                {t(
                  "Бэкенды не запущены. Нажмите «Старт» в верхней панели или проверьте пути CLI в разделе «Аккаунты и CLI».",
                )}
              </div>
            ) : (
              status?.backends.map((b) => (
                <div
                  key={b.key}
                  className="flex items-center justify-between gap-3 px-4 py-[var(--density-cell-y)] transition-colors hover:bg-[var(--bg-subtle)]"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <BrandIcon brand={b.kind} size={18} />
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[var(--fg)]">{b.label}</div>
                      <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                        {b.error ? b.error : b.executable || b.key}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-[11px] tabular-nums">
                    <span className="text-[var(--fg-muted)]">
                      {b.modelsCount} {plural(lang, b.modelsCount, [t("модель"), t("модели"), t("моделей")])}
                    </span>
                    <span className="hidden text-[var(--fg-subtle)] sm:inline">
                      {b.activeSessions} {plural(lang, b.activeSessions, [t("сессия"), t("сессии"), t("сессий")])}
                    </span>
                    <StatusDot
                      on={Boolean(b.ready && !b.error)}
                      danger={Boolean(b.error)}
                      label={b.error ? t("Ошибка") : b.ready ? t("Готов") : t("Спит")}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
};
