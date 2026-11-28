import React, { useMemo, useState } from "react";
import { Check, Copy, MessageSquare } from "lucide-react";
import type { BackendModelEntry } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";
import { Button, PageHeader, Panel, SearchInput } from "./components/ui";
import { formatTokens } from "./format";
import { useI18n } from "./i18n";

interface ModelsViewProps {
  models: BackendModelEntry[];
  onTestModel: (qualifiedId: string) => void;
}

export const ModelsView: React.FC<ModelsViewProps> = ({ models, onTestModel }) => {
  const { t } = useI18n();
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
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b px-6 py-3.5">
        <PageHeader
          title={t("Модели")}
          description={t("{count} моделей со всех активных провайдеров и аккаунтов", { count: models.length })}
        >
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Поиск модели или провайдера")}
            className="w-60"
          />
          <Select
            value={backendFilter}
            onChange={setBackendFilter}
            ariaLabel={t("Провайдер")}
            className="w-48"
            options={[
              { value: "all", label: t("Все провайдеры · {count}", { count: models.length }) },
              ...backends.map(([k, lbl]) => ({ value: k, label: lbl })),
            ]}
          />
        </PageHeader>
      </div>

      <div className="page-scroll p-6">
        <Panel className="mx-auto max-w-6xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Модель")}</th>
                  <th>{t("Провайдер")}</th>
                  <th>{t("ID для OpenAI и Codex")}</th>
                  <th className="text-right">{t("Контекст")}</th>
                  <th className="text-right">{t("Действия")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-[var(--fg-muted)]">
                      {t("Модели не найдены. Запустите прокси или нажмите «Обновить модели».")}
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => (
                    <tr key={m.qualifiedId}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <BrandIcon brand={m.brand} size={18} />
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-medium text-[var(--fg)]">
                              {m.displayName}
                            </div>
                            <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                              {m.description}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-[11px] text-[var(--fg-muted)]">
                        {m.backendLabel}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <span className="max-w-[220px] truncate text-[11px] text-[var(--fg-muted)]">
                            {m.qualifiedId}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => copyId(`q-${m.qualifiedId}`, m.qualifiedId)}
                            title={t("Скопировать ID для OpenAI и Codex")}
                            aria-label={t("Скопировать ID для OpenAI и Codex")}
                            className="size-6 rounded-[4px] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                          >
                            {copiedKey === `q-${m.qualifiedId}` ? (
                              <Check className="size-3 text-[var(--success)]" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                          </Button>
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-[11px] text-[var(--fg-muted)]">
                        {formatTokens(m.maxInputTokens)}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => copyId(`g-${m.qualifiedId}`, m.gatewayId)}
                            className="text-[var(--fg-muted)]"
                          >
                            {copiedKey === `g-${m.qualifiedId}` ? (
                              <Check className="size-3 text-[var(--success)]" />
                            ) : (
                              <Copy className="size-3" />
                            )}
                            <span>Claude ID</span>
                          </Button>
                          <Button variant="secondary" size="xs" onClick={() => onTestModel(m.qualifiedId)}>
                            <MessageSquare className="size-3" />
                            <span>{t("Тест")}</span>
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
