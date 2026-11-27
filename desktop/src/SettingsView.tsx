import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FolderOpen, Save, Check, RefreshCw, Download, ExternalLink, Loader2 } from "lucide-react";
import type {
  AppSettings,
  AppUpdateInfo,
  DevinMode,
  OpenCodeFilterMode,
  ProcessModel,
  ShowToolsMode,
  SpeedMode,
  ThoughtLevel,
} from "./types";
import { Select } from "./Select";
import { Button, Input, Panel, PanelDescription, PanelTitle, Switch } from "./components/ui";

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

  React.useEffect(() => {
    setDraft((d) => ({ ...d, theme: settings.theme, autostartOs: settings.autostartOs }));
  }, [settings.theme, settings.autostartOs]);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    phase: string;
    percent: number;
    message: string;
  } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<{
      phase: string;
      downloaded: number;
      total: number;
      percent: number;
      message: string;
    }>("app-update-progress", (ev) => {
      setUpdateProgress(ev.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

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

  const handleInstallUpdate = async () => {
    if (!updateInfo) return;
    setInstallingUpdate(true);
    setUpdateErr(null);
    setUpdateMsg(null);
    setUpdateProgress(null);
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
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.02em]">Настройки и кастомизация</h1>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5">
              Параметры HTTP-шлюзов, ACP-выполнения, внешнего вида и автозапуска.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => handleSave(true)} disabled={saving}>
            {savedToast ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
            <span>{savedToast ? "Сохранено" : "Сохранить и применить"}</span>
          </Button>
        </div>

        <Panel className="p-4 space-y-4">
          <PanelTitle>Внешний вид и поведение</PanelTitle>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Тема</span>
              <Select
                value={draft.theme}
                onChange={(v) => setDraft({ ...draft, theme: v as AppSettings["theme"] })}
                options={[
                  { value: "auto", label: "Авто" },
                  { value: "dark", label: "Тёмная" },
                  { value: "light", label: "Светлая" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Акцентный цвет</span>
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
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Плотность интерфейса</span>
              <Select
                value={draft.density}
                onChange={(v) => setDraft({ ...draft, density: v as AppSettings["density"] })}
                options={[
                  { value: "comfortable", label: "Обычная" },
                  { value: "compact", label: "Компактная" },
                ]}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1">
            <Switch
              checked={draft.autostartOs}
              onCheckedChange={(val) => {
                setDraft({ ...draft, autostartOs: val });
                onToggleAutostart(val).catch(() => {});
              }}
              label="Запускать вместе с системой"
            />
            <Switch
              checked={draft.autoStartProxy}
              onCheckedChange={(val) => setDraft({ ...draft, autoStartProxy: val })}
              label="Автозапуск прокси при старте"
            />
            <Switch
              checked={draft.minimizeToTray}
              onCheckedChange={(val) => setDraft({ ...draft, minimizeToTray: val })}
              label="Сворачивать в системный трей"
            />
            <Switch
              checked={draft.showThinkingInChat}
              onCheckedChange={(val) => setDraft({ ...draft, showThinkingInChat: val })}
              label="Раскрывать блок мыслей в тест-чате"
            />
            <Switch
              checked={draft.checkUpdatesOnStart ?? true}
              onCheckedChange={(val) => setDraft({ ...draft, checkUpdatesOnStart: val })}
              label="Проверять обновления на GitHub"
            />
          </div>
        </Panel>

        <Panel className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <PanelTitle>Обновления приложения</PanelTitle>
              <PanelDescription>
                Проверка релизов на GitHub. Обновление ставится поверх, приложение перезапустится само;
                токен, аккаунты и настройки сохраняются.
              </PanelDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xs" onClick={handleCheckUpdate} disabled={checkingUpdate}>
                {checkingUpdate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                <span>Проверить обновления</span>
              </Button>
              {updateInfo?.hasUpdate && (
                <Button variant="primary" size="xs" onClick={handleInstallUpdate} disabled={installingUpdate}>
                  {installingUpdate ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  <span>
                    {installingUpdate
                      ? "Обновление..."
                      : `Обновить и перезапустить (v${updateInfo.latestVersion})`}
                  </span>
                </Button>
              )}
              {updateInfo?.releaseUrl && (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => openUrl(updateInfo.releaseUrl).catch(() => {})}
                  title="Открыть на GitHub"
                >
                  <ExternalLink className="size-3" />
                </Button>
              )}
            </div>
          </div>
          {installingUpdate && updateProgress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-[var(--fg-muted)] tabular-nums">
                <span>{updateProgress.message}</span>
                <span>{Math.round(updateProgress.percent)}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
                  style={{ width: `${Math.max(4, Math.min(100, updateProgress.percent))}%` }}
                />
              </div>
            </div>
          )}
          {updateMsg && <p className="text-xs text-[var(--success)]">{updateMsg}</p>}
          {updateErr && <p className="text-xs text-[var(--danger)]">{updateErr}</p>}
          {updateInfo?.hasUpdate && updateInfo.assetName && (
            <div className="text-[11px] text-[var(--fg-muted)]">
              Файл: {updateInfo.assetName}
              {updateInfo.assetSize ? ` (${(updateInfo.assetSize / (1024 * 1024)).toFixed(1)} МБ)` : ""}
            </div>
          )}
        </Panel>

        <Panel className="p-4 space-y-4">
          <PanelTitle>HTTP шлюзы (Anthropic и OpenAI)</PanelTitle>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Host</span>
              <Input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Порт Anthropic</span>
              <Input
                type="number"
                value={draft.anthropicPort}
                onChange={(e) => setDraft({ ...draft, anthropicPort: Number(e.target.value) || 8787 })}
                className="tabular-nums"
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Порт OpenAI и Codex</span>
              <Input
                type="number"
                value={draft.openaiPort}
                onChange={(e) => setDraft({ ...draft, openaiPort: Number(e.target.value) || 8788 })}
                className="tabular-nums"
              />
            </label>
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">API ключ</span>
              <Input
                type="password"
                value={draft.apiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value || null })}
                placeholder="Без ключа"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
            <Switch
              checked={draft.enableAnthropic}
              onCheckedChange={(val) => setDraft({ ...draft, enableAnthropic: val })}
              label="Anthropic API"
            />
            <Switch
              checked={draft.enableOpenai}
              onCheckedChange={(val) => setDraft({ ...draft, enableOpenai: val })}
              label="OpenAI API"
            />
            <Switch
              checked={draft.gatewayAliases}
              onCheckedChange={(val) => setDraft({ ...draft, gatewayAliases: val })}
              label="Алиасы Claude Desktop"
            />
          </div>
        </Panel>

        <Panel className="p-4 space-y-4">
          <PanelTitle>Движки ACP и параметры моделей</PanelTitle>
          <PanelDescription>
            Таймаут считается по молчанию процесса: пока модель присылает мысли, текст или вызовы
            инструментов, запрос живёт. Обрывается только если ответа нет совсем.
          </PanelDescription>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="space-y-1.5 md:col-span-2">
              <span className="block text-[var(--fg-muted)]">Рабочая директория (CWD)</span>
              <div className="flex gap-1.5">
                <Input
                  value={draft.cwd}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  className="flex-1"
                />
                <Button variant="secondary" size="icon" onClick={pickCwd} aria-label="Выбрать директорию">
                  <FolderOpen className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Режим прав</span>
              <Select
                value={draft.mode}
                onChange={(v) => setDraft({ ...draft, mode: v as DevinMode })}
                options={["bypass", "accept-edits", "smart", "ask", "plan"].map((v) => ({ value: v, label: v }))}
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Effort по умолчанию</span>
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
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Скорость</span>
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
            </div>
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Ожидание модели, мин</span>
              <Input
                type="number"
                min={1}
                max={120}
                value={Math.max(1, Math.round((draft.requestTimeoutMs || 900_000) / 60_000))}
                onChange={(e) => {
                  const mins = Math.max(1, Math.min(120, Number(e.target.value) || 15));
                  setDraft({ ...draft, requestTimeoutMs: mins * 60_000 });
                }}
                className="tabular-nums"
              />
            </label>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Отображение tool calls</span>
              <Select
                value={draft.showTools}
                onChange={(v) => setDraft({ ...draft, showTools: v as ShowToolsMode })}
                options={[
                  { value: "thinking", label: "В блоке мыслей" },
                  { value: "text", label: "В тексте ответа" },
                  { value: "none", label: "Скрывать" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Фильтр OpenCode</span>
              <Select
                value={draft.opencodeFilter}
                onChange={(v) => setDraft({ ...draft, opencodeFilter: v as OpenCodeFilterMode })}
                options={[
                  { value: "go-free", label: "Go + Бесплатные" },
                  { value: "all", label: "Все модели" },
                  { value: "custom", label: "Свой список провайдеров" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Devin Process Model</span>
              <Select
                value={draft.processModel}
                onChange={(v) => setDraft({ ...draft, processModel: v as ProcessModel })}
                options={[
                  { value: "in-process", label: "in-process" },
                  { value: "daemon", label: "daemon" },
                ]}
              />
            </div>
            <label className="space-y-1.5">
              <span className="block text-[var(--fg-muted)]">Ключ XAI для Grok</span>
              <Input
                type="password"
                value={draft.xaiApiKey ?? ""}
                onChange={(e) => setDraft({ ...draft, xaiApiKey: e.target.value || null })}
                placeholder="Или cached_token"
              />
            </label>
          </div>
          <Switch
            checked={draft.debug}
            onCheckedChange={(val) => setDraft({ ...draft, debug: val })}
            label="Подробные debug логи stderr и RPC"
            className="max-w-sm"
          />
        </Panel>
      </div>
    </div>
  );
};
