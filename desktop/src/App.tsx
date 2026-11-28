import React, { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  LayoutDashboard,
  MessageSquare,
  Boxes,
  KeyRound,
  BarChart3,
  ScrollText,
  Settings,
  Copy,
  Check,
} from "lucide-react";
import type {
  AppSettings,
  AppUpdateInfo,
  BackendModelEntry,
  DetectedRuntimes,
  ProxyRuntimeStatus,
  UsageSummary,
} from "./types";
import { TitleBar } from "./TitleBar";
import { OverviewView } from "./OverviewView";
import { ChatView } from "./ChatView";
import { ModelsView } from "./ModelsView";
import { AccountsView } from "./AccountsView";
import { UsageView } from "./UsageView";
import { LogsView } from "./LogsView";
import { SettingsView } from "./SettingsView";
import { refreshQuotas } from "./quotaCache";
import { I18nProvider, useI18n } from "./i18n";

type TabId = "overview" | "chat" | "models" | "accounts" | "usage" | "logs" | "settings";

const NAV_ITEMS: Array<{
  id: TabId;
  labelKey: string;
  icon: React.FC<{ className?: string; strokeWidth?: number }>;
}> = [
  { id: "overview", labelKey: "Шлюзы", icon: LayoutDashboard },
  { id: "chat", labelKey: "Тест-чат", icon: MessageSquare },
  { id: "models", labelKey: "Модели", icon: Boxes },
  { id: "accounts", labelKey: "Аккаунты и CLI", icon: KeyRound },
  { id: "usage", labelKey: "Траты", icon: BarChart3 },
  { id: "logs", labelKey: "Логи", icon: ScrollText },
  { id: "settings", labelKey: "Настройки", icon: Settings },
];

const SidebarPortRow: React.FC<{
  name: string;
  port: number;
  active: boolean;
  host: string;
  pathSuffix?: string;
}> = ({ name, port, active, host, pathSuffix = "" }) => {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const url = `http://${host}:${port}${pathSuffix}`;
  return (
    <button
      type="button"
      title={copied ? t("Скопировано") : t("Скопировать {url}", { url })}
      aria-label={t("Скопировать адрес {name}", { name })}
      onClick={() => {
        navigator.clipboard.writeText(url).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between rounded-[5px] px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-subtle)]"
    >
      <span className="flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${active ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"}`}
        />
        <span>{name}</span>
      </span>
      <span className="flex items-center gap-1 text-[var(--fg-muted)]">
        {copied ? (
          <Check className="size-3 text-[var(--success)]" />
        ) : (
          <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
        <span>:{port}</span>
      </span>
    </button>
  );
};

function AppInner({ onLanguageChange }: { onLanguageChange: (lang: string) => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>("overview");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<ProxyRuntimeStatus | null>(null);
  const [models, setModels] = useState<BackendModelEntry[]>([]);
  const [runtimes, setRuntimes] = useState<DetectedRuntimes | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [warmingUp, setWarmingUp] = useState(false);
  const [chatPreselectModel, setChatPreselectModel] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  const loadAll = async (usageDays = 30) => {
    try {
      const [s, st, m, rt, u] = await Promise.all([
        invoke<AppSettings>("get_settings"),
        invoke<ProxyRuntimeStatus>("get_proxy_status"),
        invoke<BackendModelEntry[]>("list_models"),
        invoke<DetectedRuntimes>("detect_runtimes"),
        invoke<UsageSummary>("get_usage_summary", { days: usageDays }),
      ]);
      setSettings(s);
      setStatus(st);
      setModels(m);
      setRuntimes(rt);
      setUsage(u);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadAll();
    refreshQuotas().catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
    const u1 = listen("proxy-status-updated", () => {
      invoke<ProxyRuntimeStatus>("get_proxy_status").then(setStatus).catch(() => {});
      invoke<BackendModelEntry[]>("list_models").then(setModels).catch(() => {});
      invoke<DetectedRuntimes>("detect_runtimes").then(setRuntimes).catch(() => {});
    });
    const u2 = listen("request-log", () => {
      invoke<UsageSummary>("get_usage_summary", { days: 30 }).then(setUsage).catch(() => {});
    });
    const u3 = listen<AppSettings>("settings-updated", (ev) => {
      setSettings(ev.payload);
    });
    return () => {
      u1.then((f) => f()).catch(() => {});
      u2.then((f) => f()).catch(() => {});
      u3.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (settings?.language) onLanguageChange(settings.language);
  }, [settings?.language]);

  useEffect(() => {
    if (!settings || settings.checkUpdatesOnStart === false) return;
    const timer = setTimeout(() => {
      invoke<AppUpdateInfo>("check_app_update")
        .then((info) => setUpdateInfo(info))
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [settings?.checkUpdatesOnStart]);

  useEffect(() => {
    if (!settings) return;
    const html = document.documentElement;
    const apply = () => {
      const resolved =
        settings.theme === "auto"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : settings.theme;
      html.setAttribute("data-theme", resolved);
      html.setAttribute("data-accent", settings.accent || "copper");
      html.setAttribute("data-density", settings.density || "comfortable");
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings?.theme, settings?.accent, settings?.density]);

  const handleSaveSettings = async (next: AppSettings, restart = true) => {
    const saved = await invoke<AppSettings>("save_settings", {
      newSettings: next,
      restartIfRunning: restart,
    });
    setSettings(saved);
    await loadAll();
  };

  const handleCycleTheme = () => {
    if (!settings) return;
    const order: Array<AppSettings["theme"]> = ["auto", "dark", "light"];
    const nextTheme = order[(order.indexOf(settings.theme) + 1) % order.length] ?? "auto";
    handleSaveSettings({ ...settings, theme: nextTheme }, false).catch(() => {});
  };

  const handleToggleProxy = async () => {
    if (!status) return;
    const next = status.running
      ? await invoke<ProxyRuntimeStatus>("stop_proxy")
      : await invoke<ProxyRuntimeStatus>("start_proxy");
    setStatus(next);
    invoke<BackendModelEntry[]>("list_models").then(setModels).catch(() => {});
  };

  const handleWarmUp = async () => {
    setWarmingUp(true);
    try {
      const m = await invoke<BackendModelEntry[]>("warm_up_backends", { force: true });
      setModels(m);
      setStatus(await invoke<ProxyRuntimeStatus>("get_proxy_status"));
    } finally {
      setWarmingUp(false);
    }
  };

  const handleToggleAutostart = async (enabled: boolean) => {
    await invoke("set_autostart", { enabled });
  };

  if (!settings) {
    return (
      <div className="h-dvh w-screen flex items-center justify-center bg-[var(--bg)] text-[12px] text-[var(--fg-subtle)]">
        {t("Инициализация локального прокси…")}
      </div>
    );
  }

  const agyAccounts = runtimes?.antigravityAccounts ?? settings.antigravityAccounts;

  return (
    <div className="h-dvh w-screen flex flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <TitleBar
        status={status}
        theme={settings.theme}
        updateInfo={updateInfo}
        onOpenUpdates={() => setTab("settings")}
        onCycleTheme={handleCycleTheme}
        onToggleProxy={handleToggleProxy}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <nav className="w-52 shrink-0 border-r bg-[var(--sidebar-bg)] px-2 py-2.5 flex flex-col justify-between">
          <div className="space-y-px">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`w-full flex h-8 items-center gap-2.5 rounded-[6px] px-2 text-[12.5px] transition-colors ${
                    active
                      ? "bg-[var(--control-active)] font-medium text-[var(--fg)] shadow-[inset_0_0_0_1px_var(--border)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
                  }`}
                >
                  <Icon
                    className={`size-[15px] shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`}
                    strokeWidth={1.8}
                  />
                  <span className="truncate">{t(item.labelKey)}</span>
                  {item.id === "models" && models.length > 0 && (
                    <span className="ml-auto text-[11px] tabular-nums text-[var(--fg-subtle)]">
                      {models.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-1 border-t px-1.5 pt-2.5 text-[11px] text-[var(--fg-subtle)] tabular-nums">
            <div className="flex items-center justify-between px-1.5">
              <span className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 rounded-full ${
                    status?.starting
                      ? "bg-[var(--warning)] animate-pulse"
                      : status?.running
                        ? "bg-[var(--success)]"
                        : "bg-[var(--border-strong)]"
                  }`}
                />
                <span>{t("Шлюз")}</span>
              </span>
              <span className="text-[var(--fg-muted)]">
                {status?.starting
                  ? t("запуск")
                  : status?.running
                    ? t("работает")
                    : t("остановлен")}
              </span>
            </div>
            <SidebarPortRow
              name="Anthropic"
              port={settings.anthropicPort}
              host={settings.host}
              active={Boolean(status?.running && settings.enableAnthropic)}
            />
            <SidebarPortRow
              name="OpenAI"
              port={settings.openaiPort}
              host={settings.host}
              pathSuffix="/v1"
              active={Boolean(status?.running && settings.enableOpenai)}
            />
            {appVersion && (
              <div className="flex items-center justify-between px-1.5 pt-1 text-[11px] text-[var(--fg-subtle)]">
                <span>{t("Версия")}</span>
                <span>v{appVersion}</span>
              </div>
            )}
          </div>
        </nav>

        <main className="flex-1 min-w-0 min-h-0 overflow-hidden bg-[var(--bg)]">
          {tab === "overview" && (
            <OverviewView
              status={status}
              settings={settings}
              usage={usage}
              onWarmUp={handleWarmUp}
              warmingUp={warmingUp}
              onNavigate={(tb) => setTab(tb as TabId)}
            />
          )}
          {tab === "chat" && (
            <ChatView
              models={models}
              defaultModel={settings.defaultModel}
              showThinking={settings.showThinkingInChat}
              preselectedModelId={chatPreselectModel}
            />
          )}
          {tab === "models" && (
            <ModelsView
              models={models}
              settings={settings}
              onSaveSettings={handleSaveSettings}
              onTestModel={(qid) => {
                setChatPreselectModel(qid);
                setTab("chat");
              }}
            />
          )}
          {tab === "accounts" && (
            <AccountsView
              settings={settings}
              runtimes={runtimes}
              onRefreshAll={() => loadAll()}
              onSaveSettings={handleSaveSettings}
            />
          )}
          {tab === "usage" && (
            <UsageView
              usage={usage}
              backends={status?.backends}
              antigravityAccounts={agyAccounts}
              customAcpAgents={settings.customAcpAgents}
              onReload={(d) => loadAll(d)}
            />
          )}
          {tab === "logs" && (
            <LogsView
              backends={status?.backends}
              antigravityAccounts={agyAccounts}
              customAcpAgents={settings.customAcpAgents}
            />
          )}
          {tab === "settings" && (
            <SettingsView
              settings={settings}
              updateInfo={updateInfo}
              onUpdateChecked={setUpdateInfo}
              onSave={handleSaveSettings}
              onToggleAutostart={handleToggleAutostart}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [languageSetting, setLanguageSetting] = useState<string | undefined>(undefined);
  return (
    <I18nProvider languageSetting={languageSetting}>
      <AppInner onLanguageChange={setLanguageSetting} />
    </I18nProvider>
  );
}

export default App;
