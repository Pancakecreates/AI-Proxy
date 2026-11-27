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

type TabId = "overview" | "chat" | "models" | "accounts" | "usage" | "logs" | "settings";

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: "overview", label: "Шлюзы", icon: LayoutDashboard },
  { id: "chat", label: "Тест-чат", icon: MessageSquare },
  { id: "models", label: "Модели", icon: Boxes },
  { id: "accounts", label: "Аккаунты и CLI", icon: KeyRound },
  { id: "usage", label: "Траты", icon: BarChart3 },
  { id: "logs", label: "Логи", icon: ScrollText },
  { id: "settings", label: "Настройки", icon: Settings },
];

export function App() {
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
    return () => {
      u1.then((f) => f()).catch(() => {});
      u2.then((f) => f()).catch(() => {});
    };
  }, []);

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
      <div className="h-dvh w-screen flex items-center justify-center bg-[var(--bg)] text-xs text-[var(--fg-muted)]">
        Инициализация локального прокси...
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
        <nav className="w-52 shrink-0 border-r bg-[var(--sidebar-bg)] p-2.5 flex flex-col justify-between">
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-[var(--bg-subtle)] text-[var(--fg)] shadow-[var(--panel-highlight)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]/55 hover:text-[var(--fg)]"
                  }`}
                >
                  <Icon className={`size-4 shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`} />
                  <span className="truncate">{item.label}</span>
                  {item.id === "models" && models.length > 0 && (
                    <span className="ml-auto rounded-[5px] bg-[var(--bg)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-subtle)] tabular-nums">
                      {models.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t pt-2.5 px-2 text-[11px] text-[var(--fg-subtle)] space-y-1.5 tabular-nums">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 rounded-full ${
                    status?.running && settings.enableAnthropic ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                  }`}
                />
                <span>Anthropic</span>
              </span>
              <span className="text-[var(--fg-muted)]">:{settings.anthropicPort}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 rounded-full ${
                    status?.running && settings.enableOpenai ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                  }`}
                />
                <span>OpenAI</span>
              </span>
              <span className="text-[var(--fg-muted)]">:{settings.openaiPort}</span>
            </div>
            {appVersion && (
              <div className="pt-1 border-t border-[var(--border)]/60 flex items-center justify-between text-[10px] text-[var(--fg-subtle)]">
                <span>Версия</span>
                <span>v{appVersion}</span>
              </div>
            )}
          </div>
        </nav>

        <main className="flex-1 min-w-0 min-h-0 overflow-hidden bg-[var(--bg)]">
          {tab === "overview" && (
            <div className="h-full overflow-y-auto">
              <OverviewView
                status={status}
                settings={settings}
                usage={usage}
                onWarmUp={handleWarmUp}
                warmingUp={warmingUp}
                onNavigate={(t) => setTab(t as TabId)}
              />
            </div>
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

export default App;
