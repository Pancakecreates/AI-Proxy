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
import { Badge, Button, Panel, SearchInput, Segmented } from "./components/ui";

interface LogsViewProps {
  backends?: BackendHealthStatus[];
  antigravityAccounts?: AntigravityAccountConfig[];
  customAcpAgents?: CustomAcpAgentConfig[];
}

export const LogsView: React.FC<LogsViewProps> = ({
  backends = [],
  antigravityAccounts = [],
  customAcpAgents = [],
}) => {
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
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b bg-[var(--bg-elevated)] px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={subTab}
          onChange={setSubTab}
          options={[
            { value: "requests", label: `HTTP и чат запросы (${reqLogs.length})` },
            { value: "system", label: `Системные логи CLI (${appLogs.length})` },
          ]}
        />

        <div className="flex items-center gap-2">
          {subTab === "requests" ? (
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по модели, аккаунту или тексту..."
              className="w-64"
            />
          ) : (
            <Select
              value={levelFilter}
              onChange={setLevelFilter}
              ariaLabel="Уровень логов"
              className="w-36"
              options={[
                { value: "all", label: "Все уровни" },
                { value: "info", label: "Info" },
                { value: "warn", label: "Warn" },
                { value: "error", label: "Error" },
                { value: "debug", label: "Debug" },
              ]}
            />
          )}
          <Button variant="secondary" size="icon" onClick={loadLogs} title="Обновить логи" aria-label="Обновить логи">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="danger" size="sm" onClick={handleClear}>
            <Trash2 className="size-3.5" />
            <span>Очистить</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {subTab === "requests" ? (
          <Panel className="max-w-7xl mx-auto overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead className="border-b bg-[var(--bg-subtle)]/70 text-[var(--fg-muted)]">
                  <tr>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Время</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Протокол</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Аккаунт</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Модель</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Усилие</th>
                    <th className="py-2.5 px-3 font-medium whitespace-nowrap">Статус</th>
                    <th className="py-2.5 px-3 font-medium text-right whitespace-nowrap">Токены</th>
                    <th className="py-2.5 px-3 font-medium text-right whitespace-nowrap">Задержка</th>
                    <th className="py-2.5 px-3 font-medium text-right whitespace-nowrap">Стоимость</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {reqLogs.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-[var(--fg-muted)]">
                        Логи запросов пусты.
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

                      return (
                        <React.Fragment key={r.id}>
                          <tr
                            onClick={() => setExpandedId(isExpanded ? null : r.id)}
                            className={`cursor-pointer transition-colors ${
                              isExpanded ? "bg-[var(--bg-subtle)]/75" : "hover:bg-[var(--bg-subtle)]/45"
                            }`}
                          >
                            <td className="py-[var(--density-cell-y)] px-3 tabular-nums text-[var(--fg-subtle)] whitespace-nowrap">
                              {new Date(r.createdAt).toLocaleTimeString()}
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 whitespace-nowrap">
                              <Badge variant="mono" className="text-[10px]">
                                {r.protocol}
                              </Badge>
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 max-w-[200px]">
                              {acc.title === "—" ? (
                                <span className="text-[var(--fg-subtle)]">—</span>
                              ) : (
                                <div className="flex items-center gap-2 min-w-0">
                                  <BrandIcon brand={acc.brand} size={14} />
                                  <div className="min-w-0">
                                    <div
                                      className={`truncate font-medium ${
                                        acc.inferred ? "text-[var(--fg-muted)]" : "text-[var(--fg)]"
                                      }`}
                                      title={acc.key ? `${acc.title} (${acc.key})` : acc.title}
                                    >
                                      {acc.inferred ? `~ ${acc.title}` : acc.title}
                                    </div>
                                    {acc.subtitle && (
                                      <div className="truncate text-[10px] text-[var(--fg-subtle)]">
                                        {acc.subtitle}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 text-[11px] max-w-[250px]">
                              <div className="truncate text-[var(--fg)]">{r.resolvedModel || r.model}</div>
                              {r.resolvedModel && r.resolvedModel !== r.model && (
                                <div className="truncate text-[10px] text-[var(--fg-subtle)]">{r.model}</div>
                              )}
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 text-[11px] text-[var(--fg-muted)] whitespace-nowrap">
                              {r.effort || "—"}
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 whitespace-nowrap">
                              <Badge
                                variant={r.status >= 200 && r.status < 400 ? "success" : "danger"}
                                className="rounded-full px-2 text-[10px]"
                              >
                                {r.status}
                              </Badge>
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 text-right tabular-nums text-[var(--fg-muted)] whitespace-nowrap">
                              ↑ {r.inputTokens.toLocaleString()} · ↓ {r.outputTokens.toLocaleString()}
                              {r.cacheReadTokens > 0 && ` · кеш ${r.cacheReadTokens.toLocaleString()}`}
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 text-right tabular-nums text-[var(--fg-muted)] whitespace-nowrap">
                              {r.latencyMs} мс
                            </td>
                            <td className="py-[var(--density-cell-y)] px-3 text-right tabular-nums whitespace-nowrap">
                              {r.costUsd > 0 ? (
                                <span className="font-medium text-[var(--fg)]">${r.costUsd.toFixed(4)}</span>
                              ) : r.apiEquivalentUsd > 0 ? (
                                <span
                                  className="text-[var(--fg-subtle)]"
                                  title="Расчётный эквивалент стоимости API — реальное списание неизвестно"
                                >
                                  ~${r.apiEquivalentUsd.toFixed(4)}
                                </span>
                              ) : (
                                <span className="text-[var(--fg-subtle)]">—</span>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-[var(--bg)]">
                              <td colSpan={9} className="p-3.5 space-y-2.5 text-[11px]">
                                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[var(--fg-muted)] tabular-nums">
                                  <span>
                                    Аккаунт:{" "}
                                    <span className="font-medium text-[var(--fg)]">
                                      {acc.title}
                                      {r.backendKey ? ` (${r.backendKey})` : ""}
                                    </span>
                                  </span>
                                  <span>
                                    ID запроса: <code className="text-[var(--fg)]">{r.requestId}</code>
                                  </span>
                                  <span>
                                    Запрошено: <code className="text-[var(--fg)]">{r.model}</code>
                                  </span>
                                  <span>
                                    Исполнено:{" "}
                                    <code className="text-[var(--fg)]">{r.resolvedModel || "—"}</code>
                                  </span>
                                  <span>Усилие: {r.effort || "—"}</span>
                                  <span>Токены: {r.usageSource === "measured" ? "измерены" : "оценка"}</span>
                                  <span>Списано: {r.costUsd > 0 ? `$${r.costUsd.toFixed(5)}` : "неизвестно"}</span>
                                  <span title="Расчётный эквивалент стоимости публичного API">
                                    Экв. API: ~${r.apiEquivalentUsd.toFixed(5)}
                                  </span>
                                </div>
                                {r.error && (
                                  <div className="rounded-[7px] border border-[var(--danger)]/35 bg-[var(--danger-soft)] p-2.5 text-[var(--danger)]">
                                    {r.error}
                                  </div>
                                )}
                                {r.promptPreview && (
                                  <div>
                                    <div className="font-medium text-[var(--fg-muted)] mb-1">Запрос</div>
                                    <pre className="rounded-[7px] border bg-[var(--bg-elevated)] p-2.5 whitespace-pre-wrap text-[var(--fg)]">
                                      {r.promptPreview}
                                    </pre>
                                  </div>
                                )}
                                {r.responsePreview && (
                                  <div>
                                    <div className="font-medium text-[var(--fg-muted)] mb-1">Ответ</div>
                                    <pre className="rounded-[7px] border bg-[var(--bg-elevated)] p-2.5 whitespace-pre-wrap text-[var(--fg)]">
                                      {r.responsePreview}
                                    </pre>
                                  </div>
                                )}
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
          <Panel className="max-w-7xl mx-auto divide-y text-[11px] overflow-hidden">
            {appLogs.length === 0 ? (
              <div className="p-10 text-center font-sans text-xs text-[var(--fg-muted)]">
                Системные логи пусты.
              </div>
            ) : (
              appLogs.map((l) => (
                <div key={l.id} className="flex items-start gap-3 px-3.5 py-2 hover:bg-[var(--bg-subtle)]/40">
                  <span className="text-[var(--fg-subtle)] tabular-nums shrink-0">
                    {new Date(l.createdAt).toLocaleTimeString()}
                  </span>
                  <Badge
                    variant={
                      l.level === "error"
                        ? "danger"
                        : l.level === "warn"
                          ? "warning"
                          : l.level === "debug"
                            ? "neutral"
                            : "accent"
                    }
                    className="w-12 justify-center font-sans text-[10px] shrink-0"
                  >
                    {l.level}
                  </Badge>
                  <span className="text-[var(--fg-muted)] shrink-0">[{l.source}]</span>
                  <span className="text-[var(--fg)] break-all">{l.message}</span>
                </div>
              ))
            )}
          </Panel>
        )}
      </div>
    </div>
  );
};
