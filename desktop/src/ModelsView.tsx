import React, { useMemo, useState } from "react";
import { Check, Copy, MessageSquare, Search } from "lucide-react";
import type { BackendModelEntry } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";

interface ModelsViewProps {
  models: BackendModelEntry[];
  onTestModel: (qualifiedId: string) => void;
}

export const ModelsView: React.FC<ModelsViewProps> = ({ models, onTestModel }) => {
  const [search, setSearch] = useState("");
  const [backendFilter, setBackendFilter] = useState("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const backends = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) {
      map.set(m.backendKey, m.backendLabel);
    }
    return Array.from(map.entries());
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (backendFilter !== "all" && m.backendKey !== backendFilter) return false;
      if (!q) return true;
      return (
        m.displayName.toLowerCase().includes(q) ||
        m.nativeId.toLowerCase().includes(q) ||
        m.qualifiedId.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.brand.toLowerCase().includes(q)
      );
    });
  }, [models, search, backendFilter]);

  const copyId = (key: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1400);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b bg-[var(--bg-elevated)] px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Каталог моделей</h1>
          <p className="text-xs text-[var(--fg-muted)] tabular-nums">
            Доступно {models.length} моделей со всех активных провайдеров и аккаунтов
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск модели или провайдера..."
              className="h-8 w-64 rounded-md border bg-[var(--bg)] pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
          <Select
            value={backendFilter}
            onChange={setBackendFilter}
            ariaLabel="Провайдер"
            className="w-52"
            options={[
              { value: "all", label: `Все провайдеры (${models.length})` },
              ...backends.map(([k, lbl]) => ({ value: k, label: lbl })),
            ]}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b bg-[var(--bg-subtle)] text-[var(--fg-muted)] font-medium">
                <th className="py-2.5 px-3">Модель</th>
                <th className="py-2.5 px-3">Провайдер</th>
                <th className="py-2.5 px-3">OpenAI / Codex ID</th>
                <th className="py-2.5 px-3">Контекст</th>
                <th className="py-2.5 px-3 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-[var(--fg-muted)]">
                    Модели не найдены. Запустите прокси или нажмите «Обновить модели».
                  </td>
                </tr>
              ) : (
                filtered.map((m) => (
                  <tr key={m.qualifiedId} className="hover:bg-[var(--bg-subtle)]/60 transition-colors">
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2.5">
                        <BrandIcon brand={m.brand} size={20} />
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--fg)] truncate">{m.displayName}</div>
                          <div className="text-[11px] text-[var(--fg-subtle)] truncate">{m.description}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span className="inline-flex items-center rounded-md border bg-[var(--bg)] px-2 py-0.5 text-[11px] font-medium">
                        {m.backendLabel}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-[var(--fg-muted)]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate max-w-[230px]">{m.qualifiedId}</span>
                        <button
                          type="button"
                          onClick={() => copyId(`q-${m.qualifiedId}`, m.qualifiedId)}
                          title="Скопировать OpenAI / Codex ID"
                          className="text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                        >
                          {copiedKey === `q-${m.qualifiedId}` ? (
                            <Check className="size-3 text-[var(--success)]" />
                          ) : (
                            <Copy className="size-3" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-[var(--fg-muted)] whitespace-nowrap">
                      {Math.round(m.maxInputTokens / 1000)}k
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => copyId(`g-${m.qualifiedId}`, m.gatewayId)}
                          className="inline-flex h-7 items-center gap-1 rounded border bg-[var(--bg)] px-2 text-[11px] hover:bg-[var(--bg-subtle)]"
                        >
                          {copiedKey === `g-${m.qualifiedId}` ? (
                            <Check className="size-3 text-[var(--success)]" />
                          ) : (
                            <Copy className="size-3" />
                          )}
                          <span>Claude ID</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onTestModel(m.qualifiedId)}
                          className="inline-flex h-7 items-center gap-1 rounded bg-[var(--accent)] px-2.5 text-[11px] font-medium text-[var(--accent-fg)] hover:opacity-90"
                        >
                          <MessageSquare className="size-3" />
                          <span>Тест</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
