import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FolderOpen, Save, Check, RefreshCw, Download, ExternalLink, Loader2 } from "lucide-react";
import type { AppSettings, AppUpdateInfo, DevinMode, OpenCodeFilterMode, ProcessModel, ShowToolsMode, SpeedMode, ThoughtLevel } from "./types";
import { Select } from "./Select";

interface SettingsViewProps {
  settings: AppSettings;
  updateInfo: AppUpdateInfo | null;
  onUpdateChecked: (info: AppUpdateInfo | null) => void;
  onSave: (next: AppSettings, restart: boolean) => Promise<void>;
  onToggleAutostart: (enabled: boolean) => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  updateInfo,
  onUpdateChecked,
  onSave,
  onToggleAutostart,
}) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateErr(null);
    setUpdateMsg(null);
    try {
      const info = await invoke<AppUpdateInfo>("check_app_update");
      onUpdateChecked(info);
      setUpdateMsg(
        info.hasUpdate
          ? `Найдена новая версия v${info.latestVersion} (текущая v${info.currentVersion})`
          : `Установлена актуальная версия v${info.currentVersion}`,
      );
    } catch (e) {
      setUpdateErr(String(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDownloadUpdate = async () => {
    if (!updateInfo) return;
    setInstallingUpdate(true);
    setUpdateErr(null);
    try {
      const msg = await invoke<string>("download_and_launch_update", {
        assetUrl: updateInfo.assetUrl,
        assetName: updateInfo.assetName,
        releaseUrl: updateInfo.releaseUrl,
      });
      setUpdateMsg(msg);
    } catch (e) {
      setUpdateErr(String(e));
    } finally {
      setInstallingUpdate(false);
    }
  };

  const pickCwd = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: draft.cwd }).catch(() => null);
    if (typeof dir === "string" && dir) {
      setDraft((d) => ({ ...d, cwd: dir }));
    }
  };

  const handleSave = async (restart: boolean) => {
    setSaving(true);
    try {
      await onSave(draft, restart);
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Настройки и кастомизация</h1>
            <p className="text-xs text-[var(--fg-muted)]">
              Параметры HTTP-шлюзов, ACP-выполнения, внешнего вида и автозапуска.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleSave(true)}
            disabled={saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 text-xs font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {savedToast ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
            <span>{savedToast ? "Сохранено" : "Сохранить и применить"}</span>
          </button>
        </div>

        <section className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-4">
          <h2 className="text-sm font-semibold">Внешний вид и поведение</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Тема</span>
              <Select
                value={draft.theme}
                onChange={(v) => setDraft({ ...draft, theme: v as AppSettings["theme"] })}
                options={[
                  { value: "auto", label: "Авто (система)" },
                  { value: "dark", label: "Тёмная" },
                  { value: "light", label: "Светлая" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Акцентный цвет</span>
              <Select
                value={draft.accent}
                onChange={(v) => setDraft({ ...draft, accent: v as AppSettings["accent"] })}
                options={[
                  { value: "copper", label: "Оранжевый" },
                  { value: "emerald", label: "Зелёный" },
                  { value: "cobalt", label: "Синий" },
                  { value: "zinc", label: "Серый" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Плотность интерфейса</span>
              <Select
                value={draft.density}
                onChange={(v) => setDraft({ ...draft, density: v as AppSettings["density"] })}
                options={[
                  { value: "comfortable", label: "Обычная" },
                  { value: "compact", label: "Компактная" },
                ]}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.autostartOs}
                onChange={(e) => {
                  const val = e.target.checked;
                  setDraft({ ...draft, autostartOs: val });
                  onToggleAutostart(val).catch(() => {});
                }}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Запускать вместе с системой (Автозапуск)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.autoStartProxy}
                onChange={(e) => setDraft({ ...draft, autoStartProxy: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Автоматически запускать прокси при старте</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.minimizeToTray}
                onChange={(e) => setDraft({ ...draft, minimizeToTray: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Сворачивать в системный трей при закрытии</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.showThinkingInChat}
                onChange={(e) => setDraft({ ...draft, showThinkingInChat: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Раскрывать блок мыслей в тест-чате</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.checkUpdatesOnStart ?? true}
                onChange={(e) => setDraft({ ...draft, checkUpdatesOnStart: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Проверять обновления на GitHub при запуске</span>
            </label>
          </div>
        </section>

        <section className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Обновления приложения</h2>
              <p className="text-[11px] text-[var(--fg-muted)]">
                Проверка новых релизов на GitHub и скачивание установщика под текущую ОС.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-[var(--bg)] px-2.5 text-xs hover:bg-[var(--bg-subtle)] disabled:opacity-50"
              >
                {checkingUpdate ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                <span>Проверить обновления</span>
              </button>
              {updateInfo?.hasUpdate && (
                <button
                  type="button"
                  onClick={handleDownloadUpdate}
                  disabled={installingUpdate}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50"
                >
                  {installingUpdate ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  <span>Скачать и установить v{updateInfo.latestVersion}</span>
                </button>
              )}
              {updateInfo?.releaseUrl && (
                <button
                  type="button"
                  onClick={() => openUrl(updateInfo.releaseUrl).catch(() => {})}
                  className="inline-flex h-7 items-center gap-1 rounded-md border bg-[var(--bg)] px-2 text-xs hover:bg-[var(--bg-subtle)]"
                  title="Открыть на GitHub"
                >
                  <ExternalLink className="size-3" />
                </button>
              )}
            </div>
          </div>
          {updateMsg && <p className="text-xs text-[var(--success)]">{updateMsg}</p>}
          {updateErr && <p className="text-xs text-[var(--danger)]">{updateErr}</p>}
          {updateInfo?.hasUpdate && updateInfo.assetName && (
            <div className="text-[11px] text-[var(--fg-muted)] font-mono">
              Файл: {updateInfo.assetName}
              {updateInfo.assetSize ? ` (${(updateInfo.assetSize / (1024 * 1024)).toFixed(1)} МБ)` : ""}
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-4">
          <h2 className="text-sm font-semibold">HTTP шлюзы (Anthropic и OpenAI)</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Host</span>
              <input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                className="h-8 w-full rounded-md border bg-[var(--bg)] px-2.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Порт Anthropic</span>
              <input
                type="number"
                value={draft.anthropicPort}
                onChange={(e) => setDraft({ ...draft, anthropicPort: Number(e.target.value) || 8787 })}
                className="h-8 w-full rounded-md border bg-[var(--bg)] px-2.5 font-mono tabular-nums"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Порт OpenAI / Codex</span>
              <input
                type="number"
                value={draft.openaiPort}
                onChange={(e) => setDraft({ ...draft, openaiPort: Number(e.target.value) || 8788 })}
                className="h-8 w-full rounded-md border bg-[var(--bg)] px-2.5 font-mono tabular-nums"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">API ключ (опц.)</span>
              <input
                type="password"
                value={draft.apiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value || null })}
                placeholder="Без ключа"
                className="h-8 w-full rounded-md border bg-[var(--bg)] px-2.5 font-mono"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-5 text-xs">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.enableAnthropic}
                onChange={(e) => setDraft({ ...draft, enableAnthropic: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Включить Anthropic API</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.enableOpenai}
                onChange={(e) => setDraft({ ...draft, enableOpenai: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Включить OpenAI API (/v1/chat/completions и /v1/responses)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.gatewayAliases}
                onChange={(e) => setDraft({ ...draft, gatewayAliases: e.target.checked })}
                className="accent-[var(--accent)] size-3.5"
              />
              <span>Gateway-алиасы для Claude Desktop (claude-fable-acp-*)</span>
            </label>
          </div>
        </section>

        <section className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-4">
          <h2 className="text-sm font-semibold">Движки ACP и параметры моделей</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <label className="space-y-1 md:col-span-2">
              <span className="text-[var(--fg-muted)]">Рабочая директория (CWD)</span>
              <div className="flex gap-1.5">
                <input
                  value={draft.cwd}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  className="h-8 flex-1 rounded-md border bg-[var(--bg)] px-2.5 font-mono"
                />
                <button
                  type="button"
                  onClick={pickCwd}
                  className="inline-flex h-8 items-center gap-1 rounded-md border bg-[var(--bg)] px-2.5 hover:bg-[var(--bg-subtle)]"
                >
                  <FolderOpen className="size-3.5" />
                </button>
              </div>
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Режим прав</span>
              <Select
                value={draft.mode}
                onChange={(v) => setDraft({ ...draft, mode: v as DevinMode })}
                options={["bypass", "accept-edits", "smart", "ask", "plan"].map((v) => ({ value: v, label: v }))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Effort по умолчанию</span>
              <Select
                value={draft.thoughtLevel ?? ""}
                onChange={(v) =>
                  setDraft({ ...draft, thoughtLevel: (v || null) as ThoughtLevel | null })
                }
                options={[
                  { value: "", label: "По выбору клиента" },
                  ...["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({
                    value: v,
                    label: v,
                  })),
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Скорость</span>
              <Select
                value={draft.speed ?? ""}
                onChange={(v) => setDraft({ ...draft, speed: (v || null) as SpeedMode | null })}
                options={[
                  { value: "", label: "По умолчанию" },
                  { value: "standard", label: "standard" },
                  { value: "fast", label: "fast" },
                  { value: "ultrafast", label: "ultrafast" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Отображение tool calls</span>
              <Select
                value={draft.showTools}
                onChange={(v) => setDraft({ ...draft, showTools: v as ShowToolsMode })}
                options={[
                  { value: "thinking", label: "В блоке мыслей" },
                  { value: "text", label: "В тексте ответа" },
                  { value: "none", label: "Скрывать" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Фильтр OpenCode</span>
              <Select
                value={draft.opencodeFilter}
                onChange={(v) => setDraft({ ...draft, opencodeFilter: v as OpenCodeFilterMode })}
                options={[
                  { value: "go-free", label: "Go + Бесплатные" },
                  { value: "all", label: "Все модели" },
                  { value: "custom", label: "Свой список провайдеров" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">Devin Process Model</span>
              <Select
                value={draft.processModel}
                onChange={(v) => setDraft({ ...draft, processModel: v as ProcessModel })}
                options={[
                  { value: "in-process", label: "in-process" },
                  { value: "daemon", label: "daemon" },
                ]}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[var(--fg-muted)]">XAI API Key (Grok, опц.)</span>
              <input
                type="password"
                value={draft.xaiApiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, xaiApiKey: e.target.value || null })}
                placeholder="Или cached_token"
                className="h-8 w-full rounded-md border bg-[var(--bg)] px-2.5 font-mono"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={draft.debug}
              onChange={(e) => setDraft({ ...draft, debug: e.target.checked })}
              className="accent-[var(--accent)] size-3.5"
            />
            <span>Подробные debug логи stderr / RPC</span>
          </label>
        </section>
      </div>
    </div>
  );
};
