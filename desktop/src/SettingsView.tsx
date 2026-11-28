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
import {
  Button,
  Input,
  NumberInput,
  PageHeader,
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
  Switch,
} from "./components/ui";
import { useI18n } from "./i18n";
import { ProxySettingsPanel } from "./ExternalProvidersPanel";

interface SettingsViewProps {
  settings: AppSettings;
  updateInfo: AppUpdateInfo | null;
  onUpdateChecked: (info: AppUpdateInfo | null) => void;
  onSave: (next: AppSettings, restart: boolean) => Promise<void>;
  onToggleAutostart: (enabled: boolean) => Promise<void>;
}

const Field: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({
  label,
  children,
  className,
}) => (
  <div className={`space-y-1.5 ${className ?? ""}`}>
    <span className="block text-[11px] font-medium text-[var(--fg-muted)]">{label}</span>
    {children}
  </div>
);

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  updateInfo,
  onUpdateChecked,
  onSave,
  onToggleAutostart,
}) => {
  const { t } = useI18n();
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
          ? t("Найдена новая версия v{latest} (текущая v{current})", { latest: info.latestVersion, current: info.currentVersion })
          : t("Установлена актуальная версия v{current}", { current: info.currentVersion }),
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
    <div className="page-scroll">
      <div className="page-inner max-w-[880px]">
        <PageHeader
          title={t("Настройки")}
          description={t("Параметры HTTP-шлюзов, ACP-выполнения, внешнего вида и автозапуска.")}
        >
          <Button variant="primary" size="sm" onClick={() => handleSave(true)} disabled={saving}>
            {savedToast ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
            <span>{savedToast ? t("Сохранено") : t("Сохранить и применить")}</span>
          </Button>
        </PageHeader>

        <Panel className="overflow-hidden">
          <PanelHeader>
            <PanelTitle>{t("Внешний вид и поведение")}</PanelTitle>
          </PanelHeader>
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label={t("Тема")}>
                <Select
                  value={draft.theme}
                  onChange={(v) => setDraft({ ...draft, theme: v as AppSettings["theme"] })}
                  options={[
                    { value: "auto", label: t("Авто") },
                    { value: "dark", label: t("Тёмная") },
                    { value: "light", label: t("Светлая") },
                  ]}
                />
              </Field>
              <Field label={t("Язык")}>
                <Select
                  value={draft.language || "auto"}
                  onChange={(v) => setDraft({ ...draft, language: v === "auto" ? "" : v })}
                  options={[
                    { value: "auto", label: t("Авто") },
                    { value: "ru", label: "Русский" },
                    { value: "en", label: "English" },
                  ]}
                />
              </Field>
              <Field label={t("Акцентный цвет")}>
                <Select
                  value={draft.accent}
                  onChange={(v) => setDraft({ ...draft, accent: v as AppSettings["accent"] })}
                  options={[
                    { value: "copper", label: t("Оранжевый") },
                    { value: "emerald", label: t("Зелёный") },
                    { value: "cobalt", label: t("Синий") },
                    { value: "zinc", label: t("Серый") },
                  ]}
                />
              </Field>
              <Field label={t("Плотность интерфейса")}>
                <Select
                  value={draft.density}
                  onChange={(v) => setDraft({ ...draft, density: v as AppSettings["density"] })}
                  options={[
                    { value: "comfortable", label: t("Обычная") },
                    { value: "compact", label: t("Компактная") },
                  ]}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-x-10 gap-y-0.5 border-t pt-2 sm:grid-cols-2">
              <Switch
                checked={draft.autostartOs}
                onCheckedChange={(val) => {
                  setDraft({ ...draft, autostartOs: val });
                  onToggleAutostart(val).catch(() => {});
                }}
                label={t("Запускать вместе с системой")}
              />
              <Switch
                checked={draft.autoStartProxy}
                onCheckedChange={(val) => setDraft({ ...draft, autoStartProxy: val })}
                label={t("Автозапуск прокси при старте")}
              />
              <Switch
                checked={draft.minimizeToTray}
                onCheckedChange={(val) => setDraft({ ...draft, minimizeToTray: val })}
                label={t("Сворачивать в системный трей")}
              />
              <Switch
                checked={draft.showThinkingInChat}
                onCheckedChange={(val) => setDraft({ ...draft, showThinkingInChat: val })}
                label={t("Раскрывать блок мыслей в тест-чате")}
              />
              <Switch
                checked={draft.checkUpdatesOnStart ?? true}
                onCheckedChange={(val) => setDraft({ ...draft, checkUpdatesOnStart: val })}
                label={t("Проверять обновления на GitHub")}
              />
            </div>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader className="items-start">
            <div className="min-w-0">
              <PanelTitle>{t("Обновления приложения")}</PanelTitle>
              <PanelDescription>
                {t("Обновление ставится поверх, приложение перезапустится само. Токен, аккаунты и настройки сохраняются.")}
              </PanelDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" size="xs" onClick={handleCheckUpdate} disabled={checkingUpdate}>
                {checkingUpdate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                <span>{t("Проверить")}</span>
              </Button>
              {updateInfo?.hasUpdate && (
                <Button variant="primary" size="xs" onClick={handleInstallUpdate} disabled={installingUpdate}>
                  {installingUpdate ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  <span>{installingUpdate ? t("Обновление…") : t("Обновить до v{version}", { version: updateInfo.latestVersion })}</span>
                </Button>
              )}
              {updateInfo?.releaseUrl && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openUrl(updateInfo.releaseUrl).catch(() => {})}
                  title={t("Открыть на GitHub")}
                  aria-label={t("Открыть на GitHub")}
                  className="size-7"
                >
                  <ExternalLink className="size-3" />
                </Button>
              )}
            </div>
          </PanelHeader>
          <div className="space-y-2 p-4">
            {installingUpdate && updateProgress && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] tabular-nums text-[var(--fg-muted)]">
                  <span>{updateProgress.message}</span>
                  <span>{Math.round(updateProgress.percent)}%</span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.max(4, Math.min(100, updateProgress.percent))}%` }}
                  />
                </div>
              </div>
            )}
            {updateMsg && <p className="text-[12px] text-[var(--success)]">{updateMsg}</p>}
            {updateErr && <p className="text-[12px] text-[var(--danger)]">{updateErr}</p>}
            {updateInfo?.hasUpdate && updateInfo.assetName && (
              <div className="text-[11px] text-[var(--fg-subtle)]">
                {updateInfo.assetName}
                {updateInfo.assetSize
                  ? ` · ${(updateInfo.assetSize / (1024 * 1024)).toFixed(1)} ${t("МБ")}`
                  : ""}
              </div>
            )}
            {!updateMsg && !updateErr && !installingUpdate && (
              <p className="text-[11px] text-[var(--fg-subtle)]">
                {t("Проверка идёт через GitHub Releases. Перед установкой приложение закроет прокси.")}
              </p>
            )}
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader>
            <PanelTitle>{t("HTTP-шлюзы")}</PanelTitle>
          </PanelHeader>
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label={t("Хост")}>
                <Input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
              </Field>
              <Field label={t("Порт Anthropic")}>
                <NumberInput
                  value={draft.anthropicPort}
                  onChange={(v) => setDraft({ ...draft, anthropicPort: v })}
                  min={1024}
                  max={65535}
                  ariaLabel={t("Порт Anthropic")}
                />
              </Field>
              <Field label={t("Порт OpenAI и Codex")}>
                <NumberInput
                  value={draft.openaiPort}
                  onChange={(v) => setDraft({ ...draft, openaiPort: v })}
                  min={1024}
                  max={65535}
                  ariaLabel={t("Порт OpenAI и Codex")}
                />
              </Field>
              <Field label={t("API ключ")}>
                <Input
                  type="password"
                  value={draft.apiKey ?? ""}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value || null })}
                  placeholder={t("Без ключа")}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-x-10 gap-y-0.5 border-t pt-2 sm:grid-cols-3">
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
                label={t("Алиасы Claude Desktop")}
              />
            </div>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader className="flex-col items-start gap-0.5">
            <PanelTitle>{t("Движки ACP и модели")}</PanelTitle>
            <PanelDescription>
              {t("Таймаут считается по молчанию процесса: пока модель присылает мысли, текст или вызовы инструментов, запрос живёт.")}
            </PanelDescription>
          </PanelHeader>
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={t("Рабочая директория")} className="md:col-span-2">
                <div className="flex gap-1.5">
                  <Input
                    value={draft.cwd}
                    onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                    className="flex-1"
                  />
                  <Button variant="secondary" size="icon" onClick={pickCwd} aria-label={t("Выбрать директорию")}>
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>
              </Field>
              <Field label={t("Режим прав")}>
                <Select
                  value={draft.mode}
                  onChange={(v) => setDraft({ ...draft, mode: v as DevinMode })}
                  options={[
                    { value: "bypass", label: t("Без подтверждений") },
                    { value: "accept-edits", label: t("Принимать правки") },
                    { value: "smart", label: t("Умный") },
                    { value: "ask", label: t("Спрашивать") },
                    { value: "plan", label: t("План") },
                  ]}
                />
              </Field>
              <Field label={t("Усилие по умолчанию")}>
                <Select
                  value={draft.thoughtLevel ?? ""}
                  onChange={(v) =>
                    setDraft({ ...draft, thoughtLevel: (v || null) as ThoughtLevel | null })
                  }
                  options={[
                    { value: "", label: t("По выбору клиента") },
                    { value: "none", label: t("Выкл") },
                    { value: "minimal", label: t("Минимальное") },
                    { value: "low", label: t("Низкое") },
                    { value: "medium", label: t("Среднее") },
                    { value: "high", label: t("Высокое") },
                    { value: "xhigh", label: t("Очень высокое") },
                    { value: "max", label: t("Максимум") },
                  ]}
                />
              </Field>
              <Field label={t("Скорость")}>
                <Select
                  value={draft.speed ?? ""}
                  onChange={(v) => setDraft({ ...draft, speed: (v || null) as SpeedMode | null })}
                  options={[
                    { value: "", label: t("По умолчанию") },
                    { value: "standard", label: t("Стандартная") },
                    { value: "fast", label: t("Быстрая") },
                    { value: "ultrafast", label: t("Максимальная") },
                  ]}
                />
              </Field>
              <Field label={t("Ожидание модели, мин")}>
                <NumberInput
                  value={Math.max(1, Math.round((draft.requestTimeoutMs || 900_000) / 60_000))}
                  onChange={(mins) => setDraft({ ...draft, requestTimeoutMs: mins * 60_000 })}
                  min={1}
                  max={120}
                  ariaLabel={t("Ожидание модели в минутах")}
                />
              </Field>
              <Field label={t("Показ инструментов")}>
                <Select
                  value={draft.showTools}
                  onChange={(v) => setDraft({ ...draft, showTools: v as ShowToolsMode })}
                  options={[
                    { value: "thinking", label: t("В блоке мыслей") },
                    { value: "text", label: t("В тексте ответа") },
                    { value: "none", label: t("Скрывать") },
                  ]}
                />
              </Field>
              <Field label={t("Фильтр OpenCode")}>
                <Select
                  value={draft.opencodeFilter}
                  onChange={(v) => setDraft({ ...draft, opencodeFilter: v as OpenCodeFilterMode })}
                  options={[
                    { value: "go-free", label: t("Go и бесплатные") },
                    { value: "all", label: t("Все модели") },
                    { value: "custom", label: t("Свой список провайдеров") },
                  ]}
                />
              </Field>
              <Field label="Devin process model">
                <Select
                  value={draft.processModel}
                  onChange={(v) => setDraft({ ...draft, processModel: v as ProcessModel })}
                  options={[
                    { value: "in-process", label: "in-process" },
                    { value: "daemon", label: "daemon" },
                  ]}
                />
              </Field>
              <Field label={t("Ключ XAI для Grok")}>
                <Input
                  type="password"
                  value={draft.xaiApiKey ?? ""}
                  onChange={(e) => setDraft({ ...draft, xaiApiKey: e.target.value || null })}
                  placeholder={t("Или cached_token")}
                />
              </Field>
            </div>
            <div className="border-t pt-2">
              <Switch
                checked={draft.debug}
                onCheckedChange={(val) => setDraft({ ...draft, debug: val })}
                label={t("Подробные debug-логи stderr и RPC")}
                className="max-w-sm"
              />
            </div>
          </div>
          <ProxySettingsPanel
            value={draft.proxyUrl ?? ""}
            onChange={(v) => setDraft({ ...draft, proxyUrl: v.trim() ? v : null })}
          />
        </Panel>
      </div>
    </div>
  );
};
