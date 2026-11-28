import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Trash2 } from "lucide-react";
import type {
  AntigravityAccountConfig,
  AppLogEntry,
  BackendHealthStatus,
  CustomAcpAgentConfig,
  RequestLogEntry,
} from "./types";
import { Select } from "./Select";
import { BrandIcon } from "./BrandIcon";
import { resolveAccountInfo } from "./backendDisplay";
import { Button, PageHeader, Panel, SearchInput, Segmented } from "./components/ui";
import { formatDuration, formatTokens } from "./format";

import { useI18n } from "./i18n";
interface LogsViewProps {
  backends?: BackendHealthStatus[];
  antigravityAccounts?: AntigravityAccountConfig[];
  customAcpAgents?: CustomAcpAgentConfig[];
}

const LEVEL_COLOR: Record<string, string> = {
  error: "text-[var(--danger)]",
  warn: "text-[var(--warning)]",
  debug: "text-[var(--fg-subtle)]",
  info: "text-[var(--fg-muted)]",
};

export const LogsView: React.FC<LogsViewProps> = ({
  backends = [],
  antigravityAccounts = [],
  customAcpAgents = [],
}) => {
  const { t, lang } = useI18n();
  const [subTab, setSubTab] = useState<"requests" | "system">("requests");
  const [reqLogs, setReqLogs] = useState<RequestLogEntry[]>([]);
  const [appLogs, setAppLogs] = useState<AppLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadLogs = async () => {
    const [reqs, sys] = await Promise.all([
      invoke<RequestLogEntry[]>("query_request_logs", { limit: 150, search: search || null }),
      invoke<AppLogEntry[]>("query_app_logs", { limit: 250, level: levelFilter }),
    ]);
    setReqLogs(reqs);
    setAppLogs(sys);
  };

  useEffect(() => {
    loadLogs().catch(() => {});
  }, [search, levelFilter]);

  const searchRef = React.useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const u1 = listen<RequestLogEntry>("request-log", (ev) => {
      const q = searchRef.current.trim().toLowerCase();
      if (q) {
        const r = ev.payload;
        const hay = [
          r.model,
          r.resolvedModel,
          r.backendKey,
          r.accountLabel,
          r.error,
          r.promptPreview,
          r.effort,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return;
      }
      setReqLogs((prev) => [ev.payload, ...prev].slice(0, 200));
    });
    const u2 = listen<AppLogEntry>("app-log", (ev) => {
      setAppLogs((prev) => [ev.payload, ...prev].slice(0, 300));
    });
    return () => {
      u1.then((f) => f()).catch(() => {});
      u2.then((f) => f()).catch(() => {});
    };
  }, []);

  const handleClear = async () => {
    await invoke("clear_logs", { kind: subTab === "requests" ? "requests" : "app" });
    await loadLogs();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b px-6 py-3.5">
        <PageHeader title={t("Логи")} description={t("Запросы шлюза и системные события CLI.")}>
          <Segmented
            value={subTab}
            onChange={setSubTab}
            options={[
              { value: "requests", label: t("Запросы · {count}", { count: reqLogs.length }) },
              { value: "system", label: t("Системные · {count}", { count: appLogs.length }) },
            ]}
          />
          {subTab === "requests" ? (
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Модель, аккаунт или текст")}
              className="w-56"
            />
          ) : (
            <Select
              value={levelFilter}
              onChange={setLevelFilter}
              ariaLabel={t("Уровень логов")}
              className="w-32"
              options={[
                { value: "all", label: t("Все уровни") },
                { value: "info", label: "Info" },
                { value: "warn", label: "Warn" },
                { value: "error", label: "Error" },
                { value: "debug", label: "Debug" },
              ]}
            />
          )}
          <Button variant="secondary" size="icon" onClick={loadLogs} title={t("Обновить логи")} aria-label={t("Обновить логи")}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClear} title={t("Очистить")} aria-label={t("Очистить логи")}>
            <Trash2 className="size-3.5" />
          </Button>
        </PageHeader>
      </div>

      <div className="page-scroll p-6">
        {subTab === "requests" ? (
          <Panel className="mx-auto max-w-7xl overflow-hidden">
            <div className="max-h-[calc(100dvh-13rem)] overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Время")}</th>
                    <th>{t("Протокол")}</th>
                    <th>{t("Аккаунт")}</th>
                    <th>{t("Модель")}</th>
                    <th>{t("Усилие")}</th>
                    <th>{t("Статус")}</th>
                    <th className="text-right">{t("Токены")}</th>
                    <th className="text-right">{t("Задержка")}</th>
                    <th className="text-right">{t("Стоимость")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reqLogs.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-[var(--fg-muted)]">
                        {t("Логи запросов пусты.")}
                      </td>
                    </tr>
                  ) : (
                    reqLogs.map((r) => {
                      const acc = resolveAccountInfo({
                        backendKey: r.backendKey,
                        accountLabel: r.accountLabel,
                        requestedModel: r.model,
                        backends,
                        antigravityAccounts,
                        customAcpAgents,
                      });
                      const isExpanded = expandedId === r.id;
                      const ok = r.status >= 200 && r.status < 400;

                      return (
                        <React.Fragment key={r.id}>
                          <tr
                            onClick={() => setExpandedId(isExpanded ? null : r.id)}
                            className={`cursor-pointer ${isExpanded ? "bg-[var(--bg-subtle)]" : ""}`}
                          >
                            <td className="whitespace-nowrap tabular-nums text-[var(--fg-subtle)]">
                              {new Date(r.createdAt).toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            </td>
                            <td className="whitespace-nowrap text-[11px] text-[var(--fg-muted)]">
                              {r.protocol}
                            </td>
                            <td className="max-w-[150px]">
                              {acc.title === "—" ? (
                                <span className="text-[var(--fg-subtle)]">—</span>
                              ) : (
                                <div className="flex min-w-0 items-center gap-2">
                                  <BrandIcon brand={acc.brand} size={14} />
                                  <div className="min-w-0">
                                    <div
                                      className={`truncate text-[12px] ${
                                        acc.inferred
                                          ? "text-[var(--fg-muted)]"
                                          : "font-medium text-[var(--fg)]"
                                      }`}
                                      title={acc.key ? `${acc.title} (${acc.key})` : acc.title}
                                    >
                                      {acc.inferred ? `~ ${acc.title}` : acc.title}
                                    </div>
                                    {acc.subtitle && (
                                      <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                                        {acc.subtitle}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </td>
                            <td className="max-w-[170px]">
                              <div className="truncate text-[11px] text-[var(--fg)]">
                                {r.resolvedModel || r.model}
                              </div>
                              {r.resolvedModel && r.resolvedModel !== r.model && (
                                <div className="truncate text-[11px] text-[var(--fg-subtle)]">{r.model}</div>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-[11px] text-[var(--fg-muted)]">
                              {r.effort || "—"}
                            </td>
                            <td className="whitespace-nowrap">
                              <span
                                className={`inline-flex items-center gap-1.5 tabular-nums text-[11px] ${
                                  ok ? "text-[var(--fg-muted)]" : "text-[var(--danger)]"
                                }`}
                              >
                                <span
                                  className={`size-1.5 rounded-full ${
                                    ok ? "bg-[var(--success)]" : "bg-[var(--danger)]"
                                  }`}
                                />
                                {r.status}
                              </span>
                            </td>
                            <td
                              className="whitespace-nowrap text-right tabular-nums text-[11px] text-[var(--fg-muted)]"
                              title={t("вход {input} · выход {output}{cache}", { input: r.inputTokens.toLocaleString(), output: r.outputTokens.toLocaleString(), cache: r.cacheReadTokens > 0 ? ` · ${t("кеш")} ${r.cacheReadTokens.toLocaleString()}` : "" })}
                            >
                              ↑{formatTokens(r.inputTokens)} ↓{formatTokens(r.outputTokens)}
                              {r.cacheReadTokens > 0 && (
                                <span className="text-[var(--fg-subtle)]"> · {t("кеш")} {formatTokens(r.cacheReadTokens)}</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-right tabular-nums text-[11px] text-[var(--fg-muted)]">
                              {formatDuration(r.latencyMs)}
                            </td>
                            <td className="whitespace-nowrap text-right tabular-nums text-[11px]">
                              {r.costUsd > 0 ? (
                                <span className="font-medium text-[var(--fg)]">${r.costUsd.toFixed(4)}</span>
                              ) : r.apiEquivalentUsd > 0 ? (
                                <span
                                  className="text-[var(--fg-subtle)]"
                                  title={t("Расчётный эквивалент стоимости API — реальное списание неизвестно")}
                                >
                                  ~${r.apiEquivalentUsd.toFixed(4)}
                                </span>
                              ) : (
                                <span className="text-[var(--fg-subtle)]">—</span>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-[var(--bg-subtle)]/40">
                              <td colSpan={9} className="p-4">
                                <div className="space-y-3 text-[11px]">
                                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 md:grid-cols-4">
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Аккаунт")}</div>
                                      <div className="truncate font-medium text-[var(--fg)]">
                                        {acc.title}
                                        {r.backendKey ? ` · ${r.backendKey}` : ""}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Запрошено")}</div>
                                      <div className="truncate text-[var(--fg)]">{r.model}</div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Исполнено")}</div>
                                      <div className="truncate text-[var(--fg)]">{r.resolvedModel || "—"}</div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Усилие")}</div>
                                      <div className="text-[var(--fg)]">{r.effort || "—"}</div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Токены")}</div>
                                      <div className="text-[var(--fg)]">
                                        {r.usageSource === "measured" ? t("измерены") : t("оценка")}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Списано")}</div>
                                      <div className="text-[var(--fg)]">
                                        {r.costUsd > 0 ? `$${r.costUsd.toFixed(5)}` : t("неизвестно")}
                                      </div>
                                    </div>
                                    <div title={t("Расчётный эквивалент стоимости публичного API")}>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("Эквивалент API")}</div>
                                      <div className="text-[var(--fg)]">~${r.apiEquivalentUsd.toFixed(5)}</div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-[var(--fg-subtle)]">{t("ID запроса")}</div>
                                      <div className="truncate text-[var(--fg-muted)]">{r.requestId}</div>
                                    </div>
                                  </div>

                                  {r.error && (
                                    <div className="rounded-[5px] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2.5 text-[var(--danger)]">
                                      {r.error}
                                    </div>
                                  )}
                                  {r.promptPreview && (
                                    <div>
                                      <div className="mb-1 text-[11px] text-[var(--fg-subtle)]">{t("Запрос")}</div>
                                      <pre className="whitespace-pre-wrap rounded-[5px] bg-[var(--bg-elevated)] p-2.5 text-[var(--fg)]">
                                        {r.promptPreview}
                                      </pre>
                                    </div>
                                  )}
                                  {r.responsePreview && (
                                    <div>
                                      <div className="mb-1 text-[11px] text-[var(--fg-subtle)]">{t("Ответ")}</div>
                                      <pre className="whitespace-pre-wrap rounded-[5px] bg-[var(--bg-elevated)] p-2.5 text-[var(--fg)]">
                                        {r.responsePreview}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : (
          <Panel className="mx-auto max-w-7xl overflow-hidden">
            {appLogs.length === 0 ? (
              <div className="p-10 text-center text-[12px] text-[var(--fg-muted)]">
                {t("Системные логи пусты.")}
              </div>
            ) : (
              <div className="divide-y">
                {appLogs.map((l) => (
                  <div key={l.id} className="flex items-start gap-3 px-3.5 py-1.5 text-[11px] hover:bg-[var(--bg-subtle)]">
                    <span className="shrink-0 tabular-nums text-[var(--fg-subtle)]">
                      {new Date(l.createdAt).toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span
                      className={`w-10 shrink-0 font-medium ${LEVEL_COLOR[l.level] ?? "text-[var(--fg-muted)]"}`}
                    >
                      {l.level}
                    </span>
                    <span className="shrink-0 text-[var(--fg-subtle)]">{l.source}</span>
                    <span className="break-all text-[var(--fg)]">{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
};
