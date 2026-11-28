import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, AlertCircle, Loader2, Pencil, Plus, Trash2, Globe } from "lucide-react";
import type { AppSettings, ExternalProviderConfig, ProxyMode } from "./types";
import {
  Button,
  Input,
  NumberInput,
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
  Segmented,
  Switch,
  cn,
} from "./components/ui";

interface ExternalProvidersPanelProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings, restart?: boolean) => Promise<void>;
}

interface TestResult {
  modelsCount: number;
  sampleModels: string[];
  latencyMs: number;
}

interface DraftState {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  proxyMode: ProxyMode;
  proxyUrl: string;
  maxOutputTokens: number | null;
  extraHeadersText: string;
}

const emptyDraft = (): DraftState => ({
  id: "",
  displayName: "",
  baseUrl: "",
  apiKey: "",
  proxyMode: "inherit",
  proxyUrl: "",
  maxOutputTokens: null,
  extraHeadersText: "",
});

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function draftFromConfig(cfg: ExternalProviderConfig): DraftState {
  return {
    id: cfg.id,
    displayName: cfg.displayName,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey ?? "",
    proxyMode: cfg.proxyMode,
    proxyUrl: cfg.proxyUrl ?? "",
    maxOutputTokens: cfg.maxOutputTokens,
    extraHeadersText: headersToText(cfg.extraHeaders ?? {}),
  };
}

function configFromDraft(draft: DraftState, enabled: boolean): ExternalProviderConfig {
  const id =
    draft.id ||
    draft.displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    `provider-${Date.now()}`;
  return {
    id,
    displayName: draft.displayName.trim() || id,
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim() || null,
    enabled,
    proxyMode: draft.proxyMode,
    proxyUrl: draft.proxyUrl.trim() || null,
    extraHeaders: parseHeaders(draft.extraHeadersText),
    maxOutputTokens: draft.maxOutputTokens,
  };
}

export const ExternalProvidersPanel: React.FC<ExternalProvidersPanelProps> = ({
  settings,
  onSaveSettings,
}) => {
  const providers = settings.externalProviders ?? [];
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: ExternalProviderConfig[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSaveSettings({ ...settings, externalProviders: next }, true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (cfg?: ExternalProviderConfig) => {
    setTestResult(null);
    setTestError(null);
    setDraft(cfg ? draftFromConfig(cfg) : emptyDraft());
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.displayName.trim()) {
      setTestError("Укажите название провайдера");
      return;
    }
    if (!draft.baseUrl.trim()) {
      setTestError("Укажите base URL");
      return;
    }
    const existing = providers.find((p) => p.id === draft.id);
    const cfg = configFromDraft(draft, existing?.enabled ?? true);
    const rest = providers.filter((p) => p.id !== cfg.id);
    await persist([...rest, cfg]);
    setDraft(null);
  };

  const remove = async (id: string) => {
    await persist(providers.filter((p) => p.id !== id));
  };

  const toggle = async (cfg: ExternalProviderConfig, enabled: boolean) => {
    await persist(providers.map((p) => (p.id === cfg.id ? { ...p, enabled } : p)));
  };

  const runTest = async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const cfg = configFromDraft(draft, true);
      const result = await invoke<TestResult>("test_external_provider", { config: cfg });
      setTestResult(result);
    } catch (e) {
      setTestError(String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Сторонние API</PanelTitle>
          <PanelDescription>
            OpenAI-совместимые провайдеры по base URL и ключу: OpenRouter, Together, Fireworks,
            локальные серверы и другие. Их модели появляются в общем каталоге и доступны обоим
            протоколам прокси.
          </PanelDescription>
        </div>
        {!draft && (
          <Button variant="secondary" size="sm" onClick={() => startEdit()}>
            <Plus size={14} />
            Добавить
          </Button>
        )}
      </PanelHeader>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {providers.length === 0 && !draft && (
        <div className="mt-3 rounded-md border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--fg-muted)]">
          Нет подключённых провайдеров. Добавьте первый — например, OpenRouter или локальный
          LM Studio.
        </div>
      )}

      {providers.length > 0 && (
        <div className="mt-3 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <Globe size={15} className="shrink-0 text-[var(--fg-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--fg)]">{p.displayName}</div>
                <div className="truncate text-xs text-[var(--fg-muted)]">{p.baseUrl}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => toggle(p, v)}
                  disabled={saving}
                />
                <Button variant="ghost" size="sm" onClick={() => startEdit(p)} disabled={saving}>
                  <Pencil size={13} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => remove(p.id)} disabled={saving}>
                  <Trash2 size={13} className="text-[var(--danger)]" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">Название</span>
              <Input
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                placeholder="OpenRouter"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">Base URL</span>
              <Input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://openrouter.ai/api/v1"
              />
            </label>
            <label className="col-span-2 block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">API-ключ</span>
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-or-..."
              />
            </label>
            <div className="col-span-2">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">Прокси</span>
              <Segmented
                value={draft.proxyMode}
                onChange={(v) => setDraft({ ...draft, proxyMode: v as ProxyMode })}
                options={[
                  { value: "inherit", label: "Как везде" },
                  { value: "disabled", label: "Напрямую" },
                  { value: "custom", label: "Свой" },
                ]}
              />
              {draft.proxyMode === "custom" && (
                <Input
                  className="mt-2"
                  value={draft.proxyUrl}
                  onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
                  placeholder="http://user:pass@host:port или socks5://host:port"
                />
              )}
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">
                Лимит ответа, токены
              </span>
              <NumberInput
                value={draft.maxOutputTokens ?? 16384}
                onChange={(v) => setDraft({ ...draft, maxOutputTokens: v })}
                min={256}
                max={200000}
                step={1024}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">
                Доп. заголовки <span className="text-[var(--fg-subtle)]">(необязательно)</span>
              </span>
              <textarea
                value={draft.extraHeadersText}
                onChange={(e) => setDraft({ ...draft, extraHeadersText: e.target.value })}
                placeholder={"X-Title: My App"}
                rows={2}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--fg)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>

          {testResult && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--success)] bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success)]">
              <CheckCircle2 size={14} className="mt-px shrink-0" />
              <span>
                Подключение работает: {testResult.modelsCount} моделей за {testResult.latencyMs} мс.
                {testResult.sampleModels.length > 0 && (
                  <span className="block mt-0.5 text-[var(--fg-muted)]">
                    {testResult.sampleModels.join(", ")}
                    {testResult.modelsCount > testResult.sampleModels.length ? ", …" : ""}
                  </span>
                )}
              </span>
            </div>
          )}
          {testError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span>{testError}</span>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={saveDraft}
              disabled={saving || testing}
            >
              Сохранить
            </Button>
            <Button variant="secondary" size="sm" onClick={runTest} disabled={testing || saving}>
              {testing && <Loader2 size={13} className="animate-spin" />}
              Проверить подключение
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
};

interface ProxySettingsPanelProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings, restart?: boolean) => Promise<void>;
}

interface ProxyTestResult {
  latencyMs: number;
  externalIp: string | null;
}

export const ProxySettingsPanel: React.FC<ProxySettingsPanelProps> = ({
  settings,
  onSaveSettings,
}) => {
  const [value, setValue] = useState(settings.proxyUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProxyTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = value.trim() !== (settings.proxyUrl ?? "").trim();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSaveSettings({ ...settings, proxyUrl: value.trim() || null }, true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      const url = value.trim();
      if (!url) {
        setError("Введите адрес прокси для проверки");
        return;
      }
      const r = await invoke<ProxyTestResult>("test_proxy_connection", { proxyUrl: url });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Прокси-сервер</PanelTitle>
          <PanelDescription>
            HTTP, HTTPS или SOCKS5-прокси для исходящих запросов к провайдерам. Применяется к
            CLI-процессам через переменные окружения и к сторонним API напрямую. Локальные адреса
            всегда идут без прокси.
          </PanelDescription>
        </div>
      </PanelHeader>
      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1 block">
          <span className="mb-1 block text-xs text-[var(--fg-muted)]">
            Адрес прокси <span className="text-[var(--fg-subtle)]">(пусто — напрямую)</span>
          </span>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="http://user:pass@host:8080 или socks5://127.0.0.1:1080"
          />
        </label>
        <Button variant="secondary" size="sm" onClick={test} disabled={testing}>
          {testing && <Loader2 size={13} className="animate-spin" />}
          Проверить
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={!dirty || saving}
          className={cn(!dirty && "opacity-50")}
        >
          Сохранить
        </Button>
      </div>
      {result && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--success)] bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success)]">
          <CheckCircle2 size={14} className="mt-px shrink-0" />
          <span>
            Прокси работает: ответ за {result.latencyMs} мс
            {result.externalIp ? `, внешний IP ${result.externalIp}` : ""}.
          </span>
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </Panel>
  );
};
