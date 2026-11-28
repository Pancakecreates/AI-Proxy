import React from "react";
import ReactDOM from "react-dom/client";
import {
  LayoutDashboard,
  MessageSquare,
  Boxes,
  KeyRound,
  BarChart3,
  ScrollText,
  Settings as SettingsIcon,
  Play,
  Monitor,
  Copy,
  Check,
} from "lucide-react";
import { OverviewView } from "./OverviewView";
import { SettingsView } from "./SettingsView";
import { ModelsView } from "./ModelsView";
import { UsageView } from "./UsageView";
import { LogsView } from "./LogsView";
import { ChatView } from "./ChatView";
import { AccountsView } from "./AccountsView";
import type {
  AppSettings,
  BackendModelEntry,
  ProxyRuntimeStatus,
  UsageSummary,
} from "./types";
import { I18nProvider, useI18n } from "./i18n";
import "./index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") ?? "dark");
document.documentElement.setAttribute("data-accent", "copper");
document.documentElement.setAttribute("data-density", "comfortable");
const langParam = params.get("lang") ?? "ru";

const status = {
  running: true,
  starting: false,
  anthropicUrl: "http://127.0.0.1:8787",
  openaiUrl: "http://127.0.0.1:8788/v1",
  modelsCount: 12,
  activeSessions: 2,
  lastError: null,
  backends: [
    { key: "devin", kind: "devin", label: "Devin CLI", ready: true, modelsCount: 6, activeSessions: 1, error: null, executable: "devin.exe" },
    { key: "codex", kind: "codex", label: "Codex CLI", ready: true, modelsCount: 4, activeSessions: 1, error: null, executable: "codex.exe" },
    { key: "grok", kind: "grok", label: "Grok CLI", ready: false, modelsCount: 2, activeSessions: 0, error: "Требуется вход", executable: "grok.exe" },
  ],
} as unknown as ProxyRuntimeStatus;

const settings = {
  host: "127.0.0.1",
  anthropicPort: 8787,
  openaiPort: 8788,
  enableAnthropic: true,
  enableOpenai: true,
  apiKey: "aipx_51a6761a8deab4136c937f6d06af54040d87090b",
  cwd: "C:\\Users\\Admin\\projects",
  theme: "dark",
  accent: "copper",
  density: "comfortable",
  defaultModel: "devin-adaptive",
  thoughtLevel: "high",
  speed: null,
  showTools: "none",
  processModel: "auto",
  gatewayAliases: true,
  requestTimeoutMs: 900000,
  startupTimeoutMs: 120000,
  idleSessionTtlMs: 600000,
  maxSessions: 4,
  debug: false,
  enableDevin: true,
  devinPath: "C:\\bin\\devin.exe",
  enableAntigravity: true,
  antigravityPath: null,
  antigravityAccounts: [
    { id: "agy-1", label: "work", email: "dev@example.com", geminiDir: "~/.gemini/antigravity-1", managed: true },
  ],
  customAcpAgents: [],
  enableOpencode: true,
  opencodePath: null,
  opencodeFilter: "all",
  opencodeProviders: [],
  enableGrok: true,
  grokPath: null,
  xaiApiKey: null,
  enableCodex: true,
  codexPath: null,
  enableCopilot: false,
  copilotPath: null,
  enableCursor: false,
  cursorPath: null,
  enableCline: false,
  clinePath: null,
  enableMistral: false,
  mistralPath: null,
  enableKimi: false,
  kimiPath: null,
  enableHermes: false,
  autostartOs: false,
  autoStartProxy: true,
  minimizeToTray: true,
  showThinkingInChat: true,
  checkUpdatesOnStart: true,
} as unknown as AppSettings;

const byDay = Array.from({ length: 14 }, (_, i) => {
  const day = new Date(2026, 10, 15 + i);
  const input = 40_000 + ((i * 37_913) % 180_000);
  const output = 9_000 + ((i * 11_117) % 60_000);
  return {
    key: day.toISOString().slice(0, 10),
    label: day.toISOString().slice(0, 10),
    inputTokens: input,
    outputTokens: output,
    apiEquivalentUsd: (input + output) * 0.0000021,
  };
});

const usage = {
  totalRequests: 42,
  measuredCount: 31,
  estimatedCount: 11,
  totalInputTokens: 2_214_500,
  totalOutputTokens: 621_100,
  totalCacheReadTokens: 1_480_000,
  totalThinkingTokens: 92_000,
  totalCostUsd: 0,
  totalApiEquivalentUsd: 3.04,
  avgLatencyMs: 23_309,
  successRequests: 41,
  errorRequests: 1,
  byDay,
  byBackend: [
    { key: "devin", label: "Devin CLI", requests: 24, inputTokens: 1_320_000, outputTokens: 402_000, apiEquivalentUsd: 1.82 },
    { key: "codex", label: "Codex CLI", requests: 12, inputTokens: 680_000, outputTokens: 160_000, apiEquivalentUsd: 0.96 },
    { key: "grok", label: "Grok CLI", requests: 6, inputTokens: 214_500, outputTokens: 59_100, apiEquivalentUsd: 0.26 },
  ],
  byModel: [
    { key: "devin/adaptive", label: "Devin Adaptive", requests: 18, inputTokens: 980_000, outputTokens: 310_000, apiEquivalentUsd: 1.34 },
    { key: "codex/gpt-5", label: "GPT-5", requests: 12, inputTokens: 680_000, outputTokens: 160_000, apiEquivalentUsd: 0.96 },
    { key: "devin/sonnet", label: "Claude Sonnet", requests: 6, inputTokens: 340_000, outputTokens: 92_000, apiEquivalentUsd: 0.48 },
    { key: "grok/grok-4", label: "Grok 4", requests: 6, inputTokens: 214_500, outputTokens: 59_100, apiEquivalentUsd: 0.26 },
  ],
} as unknown as UsageSummary;

const models = [
  { id: "flex", name: "flex", displayName: "Flex", gatewayId: "flex", description: "Умная маршрутизация по цене и задаче", backendKey: "flex", backendKind: "flex", backendLabel: "AI Proxy", nativeId: "flex", qualifiedId: "flex", brand: "flex", maxInputTokens: 1000000, maxTokens: 8192, supportedEfforts: ["low", "medium", "high"], supportedSpeeds: [], isFree: false, supportsImages: true },
  { id: "adaptive", name: "adaptive", displayName: "Devin Adaptive", gatewayId: "devin-adaptive", description: "Автоматический выбор", backendKey: "devin", backendKind: "devin", backendLabel: "Devin CLI", nativeId: "adaptive", qualifiedId: "devin/adaptive", brand: "devin", maxInputTokens: 200000, maxTokens: 8192, supportedEfforts: ["low", "medium", "high"], supportedSpeeds: [], isFree: false, supportsImages: true },
  { id: "gpt-5", name: "gpt-5", displayName: "GPT-5", gatewayId: "codex-gpt-5", description: "Codex flagship", backendKey: "codex", backendKind: "codex", backendLabel: "Codex CLI", nativeId: "gpt-5", qualifiedId: "codex/gpt-5", brand: "openai", maxInputTokens: 400000, maxTokens: 16384, supportedEfforts: ["low", "medium", "high"], supportedSpeeds: [], isFree: false, supportsImages: true },
  { id: "grok-4", name: "grok-4", displayName: "Grok 4", gatewayId: "grok-grok-4", description: "xAI", backendKey: "grok", backendKind: "grok", backendLabel: "Grok CLI", nativeId: "grok-4", qualifiedId: "grok/grok-4", brand: "xai", maxInputTokens: 131072, maxTokens: 8192, supportedEfforts: [], supportedSpeeds: [], isFree: false, supportsImages: false },
] as unknown as BackendModelEntry[];

const now = Date.now();
const requestLogs = [
  { id: 1, requestId: "req_8f21", protocol: "anthropic", accountLabel: "dev@example.com", backendKey: "devin", model: "claude-sonnet-5-5", resolvedModel: "devin-adaptive", effort: "high", status: 200, inputTokens: 18420, outputTokens: 3120, cacheReadTokens: 12000, latencyMs: 23309, costUsd: 0, apiEquivalentUsd: 0.0412, usageSource: "measured", promptPreview: "Отрефактори модуль роутинга", responsePreview: "Готово. Разделил resolve_target на два шага…", error: null, createdAt: new Date(now - 60_000).toISOString() },
  { id: 2, requestId: "req_8f20", protocol: "openai", accountLabel: "work@example.com", backendKey: "codex", model: "gpt-5", resolvedModel: "gpt-5", effort: "medium", status: 200, inputTokens: 9200, outputTokens: 1880, cacheReadTokens: 0, latencyMs: 8400, costUsd: 0, apiEquivalentUsd: 0.0204, usageSource: "measured", promptPreview: "Напиши тест на таймаут", responsePreview: "Тест добавлен", error: null, createdAt: new Date(now - 240_000).toISOString() },
  { id: 3, requestId: "req_8f1e", protocol: "anthropic", accountLabel: "dev@example.com", backendKey: "devin", model: "hydrogen", resolvedModel: "devin-adaptive", effort: "max", status: 502, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencyMs: 61000, costUsd: 0, apiEquivalentUsd: 0, usageSource: "none", promptPreview: "Проверь сборку", responsePreview: null, error: "Модель hydrogen недоступна у выбранного аккаунта", createdAt: new Date(now - 900_000).toISOString() },
] as unknown as import("./types").RequestLogEntry[];

const appLogs = [
  { id: 1, level: "info", source: "proxy", message: "Шлюз запущен на 127.0.0.1:8787", createdAt: new Date(now - 3600_000).toISOString() },
  { id: 2, level: "warn", source: "acp", message: "grok: ожидание входа в аккаунт", createdAt: new Date(now - 1800_000).toISOString() },
  { id: 3, level: "info", source: "router", message: "devin/adaptive → adaptive", createdAt: new Date(now - 600_000).toISOString() },
  { id: 4, level: "error", source: "router", message: "Модель hydrogen недоступна у выбранного аккаунта", createdAt: new Date(now - 900_000).toISOString() },
] as unknown as import("./types").AppLogEntry[];

const quotaReports = [
  {
    accountKey: "antigravity:agy-1",
    provider: "antigravity",
    label: "work",
    email: "dev@example.com",
    signedIn: true,
    error: null,
    verificationUrl: null,
    windows: [
      { label: "Gemini 2.5 Pro", usedPercent: 34, remainingPercent: 66, resetsAt: new Date(now + 7_200_000).toISOString() },
      { label: "Gemini 2.5 Flash", usedPercent: 12, remainingPercent: 88, resetsAt: new Date(now + 7_200_000).toISOString() },
    ],
  },
  {
    accountKey: "codex:default",
    provider: "codex",
    label: "Codex",
    email: "work@example.com",
    signedIn: true,
    error: null,
    verificationUrl: null,
    windows: [
      { label: "5 часов", usedPercent: 41, remainingPercent: 59, resetsAt: new Date(now + 3_600_000).toISOString() },
      { label: "Неделя", usedPercent: 18, remainingPercent: 82, resetsAt: new Date(now + 86_400_000).toISOString() },
    ],
  },
] as unknown as import("./types").AccountQuotaReport[];

const tauriInvoke = async (cmd: string) => {
  switch (cmd) {
    case "list_chats":
    case "get_chat_messages":
      return [];
    case "query_request_logs":
      return requestLogs;
    case "query_app_logs":
      return appLogs;
    case "get_accounts_and_quotas":
      return quotaReports;
    default:
      return null;
  }
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: tauriInvoke,
  transformCallback: () => 0,
};

const NAV = [
  { id: "overview", label: "Шлюзы", icon: LayoutDashboard },
  { id: "chat", label: "Тест-чат", icon: MessageSquare },
  { id: "models", label: "Модели", icon: Boxes },
  { id: "accounts", label: "Аккаунты и CLI", icon: KeyRound },
  { id: "usage", label: "Траты", icon: BarChart3 },
  { id: "logs", label: "Логи", icon: ScrollText },
  { id: "settings", label: "Настройки", icon: SettingsIcon },
];

const view = params.get("view") ?? "overview";

const PreviewPortRow: React.FC<{ name: string; port: number; pathSuffix?: string }> = ({
  name,
  port,
  pathSuffix = "",
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const url = `http://127.0.0.1:${port}${pathSuffix}`;
  return (
    <button
      type="button"
      title={copied ? t("Скопировано") : t("Скопировать {url}", { url })}
      onClick={() => {
        navigator.clipboard.writeText(url).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between rounded-[5px] px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-subtle)]"
    >
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-[var(--success)]" />
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

const Sidebar = () => {
  const { t } = useI18n();
  return (
  <nav className="flex w-52 shrink-0 flex-col justify-between border-r bg-[var(--sidebar-bg)] px-2 py-2.5">
    <div className="space-y-px">
      {NAV.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === view;
        return (
          <button
            key={item.id}
            type="button"
            className={`flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-[12.5px] transition-colors ${
              isActive
                ? "bg-[var(--control-active)] font-medium text-[var(--fg)] shadow-[inset_0_0_0_1px_var(--border)]"
                : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
            }`}
          >
            <Icon
              className={`size-[15px] shrink-0 ${isActive ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`}
              strokeWidth={1.8}
            />
            <span className="truncate">{t(item.label)}</span>
            {item.id === "models" && (
              <span className="ml-auto text-[11px] tabular-nums text-[var(--fg-subtle)]">12</span>
            )}
          </button>
        );
      })}
    </div>
    <div className="space-y-1 border-t px-1.5 pt-2.5 text-[11px] tabular-nums text-[var(--fg-subtle)]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[var(--success)]" />
          <span>{t("Шлюз")}</span>
        </span>
        <span className="text-[var(--fg-muted)]">{t("работает")}</span>
      </div>
      <PreviewPortRow name="Anthropic" port={8787} />
      <PreviewPortRow name="OpenAI" port={8788} pathSuffix="/v1" />
      <div className="flex items-center justify-between pt-1 text-[11px] text-[var(--fg-subtle)]">
        <span>{t("Версия")}</span>
        <span>v0.2.2</span>
      </div>
    </div>
  </nav>
  );
};

const content = () => {
  switch (view) {
    case "settings":
      return (
        <SettingsView
          settings={settings}
          updateInfo={null}
          onUpdateChecked={() => {}}
          onSave={async () => {}}
          onToggleAutostart={async () => {}}
        />
      );
    case "models":
      return (
        <ModelsView
          models={models}
          settings={settings}
          onSaveSettings={async () => {}}
          onTestModel={() => {}}
        />
      );
    case "usage":
      return <UsageView usage={usage} backends={status.backends} onReload={() => {}} />;
    case "logs":
      return <LogsView backends={status.backends} />;
    case "accounts":
      return (
        <AccountsView
          settings={settings}
          runtimes={null}
          onRefreshAll={() => {}}
          onSaveSettings={async () => {}}
        />
      );
    case "chat":
      return (
        <ChatView models={models} defaultModel="devin/adaptive" showThinking={true} preselectedModelId={null} />
      );
    default:
      return (
        <OverviewView
          status={status}
          settings={settings}
          usage={usage}
          onWarmUp={() => {}}
          warmingUp={false}
          onNavigate={() => {}}
        />
      );
  }
};

const Root = () => {
  const { t } = useI18n();
  return (
  <div className="flex h-dvh w-screen flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
    <header className="flex h-11 shrink-0 select-none items-center justify-between border-b bg-[var(--sidebar-bg)] pl-3.5 pr-0">
      <div className="flex min-w-0 items-center gap-2">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5.5 7.5L18 12L5.5 16.5" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="5.5" cy="7.5" r="2.1" fill="var(--fg-muted)" />
          <circle cx="5.5" cy="16.5" r="2.1" fill="var(--fg-muted)" />
          <circle cx="18" cy="12" r="2.4" fill="var(--accent)" />
        </svg>
        <span className="text-[12.5px] font-semibold tracking-[-0.01em]">AI Proxy</span>
        <span className="text-[11px] text-[var(--fg-subtle)]">{t("локальный шлюз")}</span>
      </div>
      <div className="flex h-full items-center gap-1">
        <span className="mr-1 inline-flex h-6.5 items-center gap-1.5 rounded-[5px] border bg-[var(--bg-elevated)] px-2 text-[11px] font-medium">
          <Play className="size-2.5 fill-current" />
          {t("Старт")}
        </span>
        <span className="inline-flex size-7 items-center justify-center rounded-[6px] text-[var(--fg-muted)]">
          <Monitor className="size-3.5" />
        </span>
        <div className="ml-1.5 flex h-full items-center border-l">
          <span className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)]">—</span>
          <span className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)]">□</span>
          <span className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)]">×</span>
        </div>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--bg)]">{content()}</main>
    </div>
  </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <I18nProvider languageSetting={langParam}>
    <Root />
  </I18nProvider>,
);
