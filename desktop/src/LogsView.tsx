import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import type { AppLogEntry, RequestLogEntry } from "./types";

export const LogsView: React.FC = () => {
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

  useEffect(() => {
    const u1 = listen<RequestLogEntry>("request-log", (ev) => {
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSubTab("requests")}
            className={`h-8 rounded-md px-3 text-xs font-medium transition-colors ${
              subTab === "requests"
                ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border bg-[var(--bg)] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            }`}
          >
            HTTP и чат запросы ({reqLogs.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab("system")}
            className={`h-8 rounded-md px-3 text-xs font-medium transition-colors ${
              subTab === "system"
                ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                : "border bg-[var(--bg)] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            }`}
          >
            Системные логи CLI ({appLogs.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          {subTab === "requests" ? (
            <div className="relative">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Фильтр по модели или тексту..."
                className="h-8 w-56 rounded-md border bg-[var(--bg)] pl-8 pr-3 text-xs"
              />
            </div>
          ) : (
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="h-8 rounded-md border bg-[var(--bg)] px-2.5 text-xs"
            >
              <option value="all">Все уровни</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
              <option value="debug">Debug</option>
            </select>
          )}
          <button
            type="button"
            onClick={loadLogs}
            className="inline-flex h-8 items-center justify-center rounded-md border bg-[var(--bg)] px-2.5 text-xs hover:bg-[var(--bg-subtle)]"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs text-[var(--danger)] hover:bg-[var(--danger)]/10"
          >
            <Trash2 className="size-3.5" />
            <span>Очистить</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {subTab === "requests" ? (
          <div className="max-w-6xl mx-auto rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="border-b bg-[var(--bg-subtle)] text-[var(--fg-muted)]">
                <tr>
                  <th className="py-2 px-3">Время</th>
                  <th className="py-2 px-3">Протокол</th>
                  <th className="py-2 px-3">Модель</th>
                  <th className="py-2 px-3">Статус</th>
                  <th className="py-2 px-3 text-right">Токены</th>
                  <th className="py-2 px-3 text-right">Задержка</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reqLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-[var(--fg-muted)]">
                      Логи запросов пусты.
                    </td>
                  </tr>
                ) : (
                  reqLogs.map((r) => (
                    <React.Fragment key={r.id}>
                      <tr
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        className="cursor-pointer hover:bg-[var(--bg-subtle)]/60"
                      >
                        <td className="py-2 px-3 tabular-nums text-[var(--fg-subtle)] whitespace-nowrap">
                          {new Date(r.createdAt).toLocaleTimeString()}
                        </td>
                        <td className="py-2 px-3">
                          <span className="rounded border bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[10px]">
                            {r.protocol}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] truncate max-w-[260px]">
                          {r.resolvedModel || r.model}
                        </td>
                        <td className="py-2 px-3 tabular-nums">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              r.status >= 200 && r.status < 400
                                ? "bg-[var(--success)]/12 text-[var(--success)]"
                                : "bg-[var(--danger)]/12 text-[var(--danger)]"
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-[var(--fg-muted)]">
                          {r.inputTokens} / {r.outputTokens}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-[var(--fg-muted)]">
                          {r.latencyMs} мс
                        </td>
                      </tr>
                      {expandedId === r.id && (
                        <tr className="bg-[var(--bg)]">
                          <td colSpan={6} className="p-3 space-y-2 text-[11px]">
                            <div className="flex flex-wrap gap-4 text-[var(--fg-muted)] tabular-nums">
                              <span>Request ID: <code className="font-mono">{r.requestId}</code></span>
                              <span>Backend: {r.backendKey || "—"}</span>
                              <span>Источник токенов: {r.usageSource}</span>
                              <span>API экв.: ${r.apiEquivalentUsd.toFixed(5)}</span>
                            </div>
                            {r.error && (
                              <div className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-2 text-[var(--danger)] font-mono">
                                {r.error}
                              </div>
                            )}
                            {r.promptPreview && (
                              <div>
                                <div className="font-medium text-[var(--fg-muted)] mb-0.5">Запрос:</div>
                                <pre className="rounded border bg-[var(--bg-elevated)] p-2 whitespace-pre-wrap font-mono">
                                  {r.promptPreview}
                                </pre>
                              </div>
                            )}
                            {r.responsePreview && (
                              <div>
                                <div className="font-medium text-[var(--fg-muted)] mb-0.5">Ответ:</div>
                                <pre className="rounded border bg-[var(--bg-elevated)] p-2 whitespace-pre-wrap font-mono">
                                  {r.responsePreview}
                                </pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="max-w-6xl mx-auto rounded-lg border bg-[var(--bg-elevated)] divide-y font-mono text-[11px]">
            {appLogs.length === 0 ? (
              <div className="p-8 text-center font-sans text-xs text-[var(--fg-muted)]">
                Системные логи пусты.
              </div>
            ) : (
              appLogs.map((l) => (
                <div key={l.id} className="flex items-start gap-3 px-3 py-2">
                  <span className="text-[var(--fg-subtle)] tabular-nums shrink-0">
                    {new Date(l.createdAt).toLocaleTimeString()}
                  </span>
                  <span
                    className={`uppercase font-semibold w-11 shrink-0 ${
                      l.level === "error"
                        ? "text-[var(--danger)]"
                        : l.level === "warn"
                          ? "text-[var(--warning)]"
                          : "text-[var(--accent)]"
                    }`}
                  >
                    {l.level}
                  </span>
                  <span className="text-[var(--fg-muted)] shrink-0">[{l.source}]</span>
                  <span className="text-[var(--fg)] break-all">{l.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
