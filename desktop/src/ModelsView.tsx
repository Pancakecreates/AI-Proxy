import React, { useMemo, useState } from "react";
import { Check, Copy, MessageSquare } from "lucide-react";
import type { BackendModelEntry } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";
import { Badge, Button, Panel, SearchInput } from "./components/ui";

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
      <div className="border-b bg-[var(--bg-elevated)] px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.02em]">Каталог моделей</h1>
          <p className="text-xs text-[var(--fg-muted)] tabular-nums mt-0.5">
            Доступно {models.length} моделей со всех активных провайдеров и аккаунтов
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск модели или провайдера..."
            className="w-64"
          />
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
        <Panel className="max-w-6xl mx-auto overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b bg-[var(--bg-subtle)]/70 text-[var(--fg-muted)]">
                  <th className="py-2.5 px-3 font-medium">Модель</th>
                  <th className="py-2.5 px-3 font-medium">Провайдер</th>
                  <th className="py-2.5 px-3 font-medium">ID для OpenAI и Codex</th>
                  <th className="py-2.5 px-3 font-medium">Контекст</th>
                  <th className="py-2.5 px-3 font-medium text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-[var(--fg-muted)]">
                      Модели не найдены. Запустите прокси или нажмите «Обновить модели».
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => (
                    <tr key={m.qualifiedId} className="hover:bg-[var(--bg-subtle)]/45 transition-colors">
                      <td className="py-[var(--density-cell-y)] px-3">
                        <div className="flex items-center gap-2.5">
                          <BrandIcon brand={m.brand} size={20} />
                          <div className="min-w-0">
                            <div className="font-medium text-[var(--fg)] truncate">{m.displayName}</div>
                            <div className="text-[11px] text-[var(--fg-subtle)] truncate">{m.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 whitespace-nowrap">
                        <Badge variant="neutral">{m.backendLabel}</Badge>
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 text-[11px] text-[var(--fg-muted)]">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate max-w-[230px]">{m.qualifiedId}</span>
                          <button
                            type="button"
                            onClick={() => copyId(`q-${m.qualifiedId}`, m.qualifiedId)}
                            title="Скопировать ID для OpenAI и Codex"
                            className="text-[var(--fg-subtle)] hover:text-[var(--fg)] transition-colors"
                          >
                            {copiedKey === `q-${m.qualifiedId}` ? (
                              <Check className="size-3 text-[var(--success)]" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 tabular-nums text-[var(--fg-muted)] whitespace-nowrap">
                        {Math.round(m.maxInputTokens / 1000)}k
                      </td>
                      <td className="py-[var(--density-cell-y)] px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => copyId(`g-${m.qualifiedId}`, m.gatewayId)}
                          >
                            {copiedKey === `g-${m.qualifiedId}` ? (
                              <Check className="size-3 text-[var(--success)]" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                            <span>Claude ID</span>
                          </Button>
                          <Button
                            variant="primary"
                            size="xs"
                            onClick={() => onTestModel(m.qualifiedId)}
                          >
                            <MessageSquare className="size-3" />
                            <span>Тест</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
};
