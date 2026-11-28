import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Download,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Terminal,
} from "lucide-react";
import type {
  AccountQuotaReport,
  AppSettings,
  CustomAcpAgentConfig,
  DetectedRuntimes,
  RuntimeInstallProgress,
} from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";
import { readQuotaCache, refreshQuotas } from "./quotaCache";
import {
  Button,
  Input,
  PageHeader,
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
  Switch,
} from "./components/ui";
import { plural, useI18n } from "./i18n";
import { ExternalProvidersPanel } from "./ExternalProvidersPanel";

interface AccountsViewProps {
  settings: AppSettings;
  runtimes: DetectedRuntimes | null;
  onRefreshAll: () => void;
  onSaveSettings: (next: AppSettings, restart?: boolean) => Promise<void>;
}

const PROVIDERS_CATALOG = [
  { key: "devin", name: "Devin CLI", brand: "devin", enableKey: "enableDevin", pathKey: "devinPath", downloadable: true, loginable: true },
  { key: "antigravity", name: "Antigravity (Gemini)", brand: "gemini", enableKey: "enableAntigravity", pathKey: "antigravityPath", downloadable: true, loginable: true },
  { key: "opencode", name: "OpenCode", brand: "opencode", enableKey: "enableOpencode", pathKey: "opencodePath", downloadable: true, loginable: true },
  { key: "grok", name: "Grok (xAI)", brand: "grok", enableKey: "enableGrok", pathKey: "grokPath", downloadable: true, loginable: true },
  { key: "codex", name: "Codex (ChatGPT)", brand: "openai", enableKey: "enableCodex", pathKey: "codexPath", downloadable: true, loginable: true },
  { key: "copilot", name: "GitHub Copilot", brand: "copilot", enableKey: "enableCopilot", pathKey: "copilotPath", downloadable: true, loginable: true },
  { key: "cursor", name: "Cursor Agent", brand: "cursor", enableKey: "enableCursor", pathKey: "cursorPath", downloadable: false, loginable: false },
  { key: "cline", name: "Cline", brand: "cline", enableKey: "enableCline", pathKey: "clinePath", downloadable: true, loginable: true },
  { key: "mistral", name: "Mistral Vibe", brand: "mistral", enableKey: "enableMistral", pathKey: "mistralPath", downloadable: true, loginable: true },
  { key: "kimi", name: "Kimi Code", brand: "kimi", enableKey: "enableKimi", pathKey: "kimiPath", downloadable: false, loginable: true },
  { key: "hermes", name: "Hermes", brand: "hermes", enableKey: "enableHermes", pathKey: "hermesPath", downloadable: false, loginable: true },
] as const;

const ACP_PRESETS = [
  {
    id: "claude-agent",
    name: "Claude Agent (ACP)",
    command: "npx",
    args: "-y @zed-industries/claude-code-acp",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    command: "gemini",
    args: "--experimental-acp",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    command: "qwen",
    args: "--experimental-acp",
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: "acp",
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    command: "kiro-cli",
    args: "acp",
  },
  {
    id: "pi",
    name: "Pi (ACP adapter)",
    command: "npx",
    args: "-y pi-acp",
  },
];

export const AccountsView: React.FC<AccountsViewProps> = ({
  settings,
  runtimes,
  onRefreshAll,
  onSaveSettings,
}) => {
  const { t, lang } = useI18n();
  const [quotas, setQuotas] = useState<AccountQuotaReport[]>(() => readQuotaCache());
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<string, RuntimeInstallProgress>>({});
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newAcpName, setNewAcpName] = useState("");
  const [newAcpCmd, setNewAcpCmd] = useState("");
  const [newAcpArgs, setNewAcpArgs] = useState("acp");
  const [newAcpAuth, setNewAcpAuth] = useState("");

  const loadQuotas = async (silent = false) => {
    if (!silent) setLoadingQuotas(true);
    try {
      setQuotas(await refreshQuotas());
    } catch (e) {
      if (!silent) setFeedback({ kind: "err", text: String(e) });
    } finally {
      if (!silent) setLoadingQuotas(false);
    }
  };

  useEffect(() => {
    const hasCache = readQuotaCache().length > 0;
    loadQuotas(hasCache);
    const timer = setInterval(() => loadQuotas(true), 5 * 60_000);
    const unlisten = listen<RuntimeInstallProgress>("runtime-install-progress", (ev) => {
      setInstallProgress((prev) => ({ ...prev, [ev.payload.provider]: ev.payload }));
    });
    return () => {
      clearInterval(timer);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleDownload = async (provider: string) => {
    setBusyKey(`dl-${provider}`);
    setFeedback(null);
    try {
      const installedPath = await invoke<string>("download_provider_runtime", { provider });
      setFeedback({ kind: "ok", text: t("CLI {provider} установлен: {path}", { provider, path: installedPath }) });
      onRefreshAll();
      await loadQuotas();
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleLogin = async (provider: string, accountId?: string) => {
    setBusyKey(`login-${provider}-${accountId ?? ""}`);
    setFeedback(null);
    try {
      const msg = await invoke<string>("login_provider_account", {
        provider,
        accountId: accountId ?? null,
      });
      setFeedback({ kind: "ok", text: `${provider}: ${msg}` });
      onRefreshAll();
      await loadQuotas();
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleAddAccount = async (provider: string) => {
    setBusyKey(`add-${provider}`);
    setFeedback(null);
    try {
      const acc = (await invoke("add_provider_account", { provider, label: null })) as { id: string; label: string };
      setFeedback({ kind: "ok", text: t("Добавлен аккаунт {provider}: {label}", { provider, label: acc.label }) });
      await handleLogin(provider, acc.id);
      onRefreshAll();
      await loadQuotas();
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  const accountsForProvider = (key: string): { id: string; label: string; email?: string | null; managed: boolean; dir: string }[] => {
    const generic = (settings.providerAccounts?.[key] ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      managed: a.managed,
      dir: a.profileDir,
    }));
    if (key !== "antigravity") return generic;
    const legacy = (runtimes?.antigravityAccounts ?? settings.antigravityAccounts).map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      managed: a.managed,
      dir: a.geminiDir,
    }));
    const ids = new Set(generic.map((a) => a.id));
    return [...generic, ...legacy.filter((a) => !ids.has(a.id))];
  };

  const handleRemoveOrLogout = async (provider: string, accountId?: string, deleteFiles = false) => {
    setBusyKey(`out-${provider}-${accountId ?? ""}`);
    setFeedback(null);
    try {
      await invoke("remove_or_logout_account", {
        provider,
        accountId: accountId ?? null,
        deleteFiles,
      });
      setFeedback({ kind: "ok", text: t("Аккаунт {provider} отключён", { provider }) });
      onRefreshAll();
      await loadQuotas();
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleProvider = async (enableKey: keyof AppSettings, current: boolean) => {
    await onSaveSettings({ ...settings, [enableKey]: !current }, true);
  };

  const handleAddCustomAcp = async () => {
    if (!newAcpName.trim() || !newAcpCmd.trim()) return;
    const item: CustomAcpAgentConfig = {
      id:
        newAcpName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || `acp-${Date.now()}`,
      name: newAcpName.trim(),
      command: newAcpCmd.trim(),
      args: newAcpArgs
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
      env: {},
      cwd: null,
      authMethodId: newAcpAuth.trim() || null,
      enabled: true,
    };
    await onSaveSettings({ ...settings, customAcpAgents: [...settings.customAcpAgents, item] }, true);
    setNewAcpName("");
    setNewAcpCmd("");
    setNewAcpArgs("acp");
    setNewAcpAuth("");
  };

  const handleDeleteCustomAcp = async (id: string) => {
    await onSaveSettings(
      {
        ...settings,
        customAcpAgents: settings.customAcpAgents.filter((c) => c.id !== id),
      },
      true,
    );
  };

  const getRuntimePath = (key: string): string | null => {
    if (!runtimes) return null;
    const map: Record<string, string | null> = {
      devin: runtimes.devinPath,
      antigravity: runtimes.antigravityPath,
      opencode: runtimes.opencodePath,
      grok: runtimes.grokPath,
      codex: runtimes.codexPath,
      copilot: runtimes.copilotPath,
      cursor: runtimes.cursorPath,
      cline: runtimes.clinePath,
      mistral: runtimes.mistralPath,
      kimi: runtimes.kimiPath,
      hermes: runtimes.hermesPath,
    };
    return map[key] ?? null;
  };

  const agyAccounts = runtimes?.antigravityAccounts ?? settings.antigravityAccounts;

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <PageHeader
          title={t("Аккаунты и CLI")}
          description={t("Вход в аккаунты внутри приложения, квоты и автоустановка недостающих движков ACP и CLI.")}
        >
          <Button variant="secondary" size="sm" onClick={() => loadQuotas()} disabled={loadingQuotas}>
            <RefreshCw className={`size-3.5 ${loadingQuotas ? "animate-spin" : ""}`} />
            <span>{t("Проверить лимиты")}</span>
          </Button>
        </PageHeader>

        {feedback && (
          <div
            className={`flex items-center gap-2 rounded-[6px] border px-3.5 py-2.5 text-[12px] ${
              feedback.kind === "ok"
                ? "border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]"
                : "border-[var(--danger)]/25 bg-[var(--danger-soft)] text-[var(--danger)]"
            }`}
          >
            {feedback.kind === "ok" ? (
              <CheckCircle2 className="size-3.5 shrink-0" />
            ) : (
              <AlertCircle className="size-3.5 shrink-0" />
            )}
            <span className="break-all">{feedback.text}</span>
          </div>
        )}

        <Panel className="overflow-hidden">
          <PanelHeader>
            <div className="flex items-center gap-2">
              <BrandIcon brand="gemini" size={17} />
              <PanelTitle>Antigravity</PanelTitle>
            </div>
            <span className="text-[11px] tabular-nums text-[var(--fg-subtle)]">
              {agyAccounts.length}{" "}
              {plural(lang, agyAccounts.length, [t("аккаунт"), t("аккаунта"), t("аккаунтов")])}
            </span>
          </PanelHeader>
          <div className="divide-y">
            {agyAccounts.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] text-[var(--fg-muted)]">
                {t("Аккаунты Antigravity не найдены. Нажмите «Добавить Antigravity», чтобы войти через Google.")}
              </div>
            ) : (
              agyAccounts.map((acc, idx) => {
                const quota = quotas.find((q) => q.accountKey === `antigravity:${acc.id}`);
                return (
                  <div key={acc.id} className="space-y-3 px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="w-4 shrink-0 text-[11px] tabular-nums text-[var(--fg-subtle)]">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium text-[var(--fg)]">
                            {quota?.email || acc.email || acc.label}
                          </div>
                          <div className="truncate text-[11px] text-[var(--fg-subtle)]">{acc.geminiDir}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {quota?.verificationUrl && (
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => openUrl(quota.verificationUrl!).catch(() => {})}
                            className="text-[var(--warning)]"
                          >
                            <ExternalLink className="size-3" />
                            <span>{t("Подтвердить")}</span>
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => handleLogin("antigravity", acc.id)}
                          disabled={busyKey !== null}
                        >
                          <LogIn className="size-3" />
                          <span>{t("Обновить вход")}</span>
                        </Button>
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => handleRemoveOrLogout("antigravity", acc.id, acc.managed)}
                          disabled={busyKey !== null}
                          title={t("Удалить аккаунт")}
                          aria-label={t("Удалить аккаунт")}
                          className="text-[var(--danger)]"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>

                    {quota?.error && <div className="text-[11px] text-[var(--fg-muted)]">{quota.error}</div>}

                    {quota && quota.windows.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {quota.windows.map((w, wi) => (
                          <div key={wi} className="space-y-2 rounded-[6px] bg-[var(--bg-subtle)] px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="truncate font-medium text-[var(--fg)]">{w.label}</span>
                              <span className="shrink-0 tabular-nums text-[var(--fg-muted)]">
                                {t("осталось {percent}%", { percent: w.remainingPercent.toFixed(0) })}
                              </span>
                            </div>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${Math.max(2, Math.min(100, w.remainingPercent))}%` }}
                              />
                            </div>
                            {w.resetsAt && (
                              <div className="text-[11px] tabular-nums text-[var(--fg-subtle)]">
                                {t("сброс")} {new Date(w.resetsAt).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        {quotas
          .filter((q) => q.provider === "codex")
          .map((cq) => (
            <Panel key={cq.accountKey} className="overflow-hidden">
              <PanelHeader>
                <div className="flex items-center gap-2.5">
                  <BrandIcon brand="openai" size={17} />
                  <div>
                    <PanelTitle>Codex</PanelTitle>
                    <div className="text-[11px] text-[var(--fg-subtle)]">
                      {cq.signedIn ? cq.email || t("Авторизован") : t("Не выполнен вход")}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="xs" onClick={() => handleLogin("codex")} disabled={busyKey !== null}>
                    <LogIn className="size-3" />
                    <span>{t("Войти")}</span>
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => handleRemoveOrLogout("codex")}
                    disabled={busyKey !== null}
                    className="text-[var(--danger)]"
                  >
                    <LogOut className="size-3" />
                    <span>{t("Выйти")}</span>
                  </Button>
                </div>
              </PanelHeader>
              {cq.windows.length > 0 && (
                <div className="grid grid-cols-1 gap-2 p-4 md:grid-cols-2">
                  {cq.windows.map((w, i) => (
                    <div key={i} className="space-y-2 rounded-[6px] bg-[var(--bg-subtle)] px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate font-medium text-[var(--fg)]">{w.label}</span>
                        <span className="shrink-0 tabular-nums text-[var(--fg-muted)]">
                          {t("{percent}% использовано", { percent: w.usedPercent.toFixed(0) })}
                        </span>
                      </div>
                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.max(2, Math.min(100, w.remainingPercent))}%` }}
                        />
                      </div>
                      {w.resetsAt && (
                        <div className="text-[11px] tabular-nums text-[var(--fg-subtle)]">
                          {t("сброс")} {new Date(w.resetsAt).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          ))}

        {quotas
          .filter((q) => q.provider !== "antigravity" && q.provider !== "codex")
          .length > 0 && (
          <Panel className="overflow-hidden">
            <PanelHeader className="flex-col items-start gap-0.5">
              <PanelTitle>{t("Лимиты провайдеров")}</PanelTitle>
              <PanelDescription>
                {t("Показываем только то, что провайдер реально отдаёт. Если остаток квоты недоступен, честно пишем об этом, а расход токенов остаётся в разделе «Траты».")}
              </PanelDescription>
            </PanelHeader>
            <div className="divide-y">
              {quotas
                .filter((q) => q.provider !== "antigravity" && q.provider !== "codex")
                .map((q) => {
                  const brand =
                    q.provider === "devin"
                      ? "devin"
                      : q.provider === "grok"
                        ? "grok"
                        : q.provider === "copilot"
                          ? "copilot"
                          : q.provider === "mistral"
                            ? "mistral"
                            : "custom";
                  return (
                    <div key={q.accountKey} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <BrandIcon brand={brand} size={17} />
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-medium text-[var(--fg)]">{q.label}</div>
                            <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                              {q.signedIn ? q.email || t("Вход выполнен") : t("Вход не выполнен")}
                            </div>
                          </div>
                        </div>
                        <span className="text-[11px] text-[var(--fg-subtle)]">
                          {q.windows.length > 0
                            ? t("{count} окон лимита", { count: q.windows.length })
                            : t("нет данных о квоте")}
                        </span>
                      </div>
                      {q.windows.map((w, wi) => (
                        <div key={wi} className="space-y-2 rounded-[6px] bg-[var(--bg-subtle)] px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate font-medium text-[var(--fg)]">{w.label}</span>
                            <span className="shrink-0 tabular-nums text-[var(--fg-muted)]">
                              {t("осталось {percent}%", { percent: w.remainingPercent.toFixed(0) })}
                            </span>
                          </div>
                          <div className="progress-track">
                            <div
                              className="progress-fill"
                              style={{ width: `${Math.max(2, Math.min(100, w.remainingPercent))}%` }}
                            />
                          </div>
                        </div>
                      ))}
                      {q.error && <div className="text-[11px] text-[var(--fg-muted)]">{t(q.error)}</div>}
                      {q.windows.length === 0 && !q.error && (
                        <div className="text-[11px] leading-relaxed text-[var(--fg-subtle)]">
                          {t("Провайдер не публикует остаток лимитов через CLI. Токены и стоимость запросов видны в «Тратах».")}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </Panel>
        )}

        <Panel className="overflow-hidden">
          <PanelHeader className="flex-col items-start gap-0.5">
            <PanelTitle>{t("Провайдеры и установка CLI")}</PanelTitle>
            <PanelDescription>
              {t("Включайте нужные движки, скачивайте отсутствующие CLI и входите в аккаунт прямо из окна.")}
            </PanelDescription>
          </PanelHeader>
          <div className="divide-y">
            {PROVIDERS_CATALOG.map((p) => {
              const exe = getRuntimePath(p.key);
              const enabled = Boolean(settings[p.enableKey]);
              const prog = installProgress[p.key];
              const isBusy = busyKey === `dl-${p.key}` || busyKey === `login-${p.key}-`;
              return (
                <div key={p.key} className="transition-colors hover:bg-[var(--bg-subtle)]">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-[var(--density-cell-y)]">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <BrandIcon brand={p.brand} size={18} />
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[var(--fg)]">{p.name}</div>
                      <div className="max-w-md truncate text-[11px] text-[var(--fg-subtle)]">
                        {prog && prog.status !== "done"
                          ? `${prog.message} (${Math.round(prog.progressPercent)}%)`
                          : exe || t("CLI не найден на диске")}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {!exe && p.downloadable && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleDownload(p.key)}
                        disabled={busyKey !== null}
                      >
                        <Download className="size-3" />
                        <span>{isBusy ? t("Установка…") : t("Скачать CLI")}</span>
                      </Button>
                    )}

                    {exe && p.loginable && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleLogin(p.key)}
                        disabled={busyKey !== null}
                      >
                        <LogIn className="size-3" />
                        <span>{t("Войти")}</span>
                      </Button>
                    )}

                    {exe && p.loginable && (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => handleAddAccount(p.key)}
                        disabled={busyKey !== null}
                        title={t("Добавить аккаунт")}
                        aria-label={t("Добавить аккаунт")}
                        className="text-[var(--accent)]"
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    )}

                    {exe && ["devin", "grok", "codex"].includes(p.key) && accountsForProvider(p.key).length === 0 && (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => handleRemoveOrLogout(p.key)}
                        disabled={busyKey !== null}
                        title={t("Выйти из аккаунта")}
                        aria-label={t("Выйти из аккаунта")}
                        className="text-[var(--danger)]"
                      >
                        <LogOut className="size-3" />
                      </Button>
                    )}

                    <div className="pl-1.5">
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggleProvider(p.enableKey, enabled)}
                      />
                    </div>
                  </div>
                </div>

                {accountsForProvider(p.key).map((acc, ai) => {
                  const quota = quotas.find((q) => q.accountKey === `${p.key}:${acc.id}`);
                  const busy = busyKey === `login-${p.key}-${acc.id}` || busyKey === `out-${p.key}-${acc.id}`;
                  return (
                    <div key={acc.id} className="flex items-center justify-between gap-3 border-t border-[var(--border)]/60 py-1.5 pl-11 pr-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="w-3.5 shrink-0 text-[10px] tabular-nums text-[var(--fg-subtle)]">{ai + 1}</span>
                        <div className="min-w-0">
                          <div className="truncate text-[11.5px] font-medium text-[var(--fg)]">
                            {quota?.email || acc.email || acc.label}
                          </div>
                          <div className="truncate text-[10.5px] text-[var(--fg-subtle)]">
                            {quota?.signedIn ? t("Вход выполнен") : t("Ожидает входа")}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => handleLogin(p.key, acc.id)}
                          disabled={busyKey !== null}
                        >
                          <LogIn className="size-3" />
                          <span>{busy ? t("Вход…") : quota?.signedIn ? t("Обновить") : t("Войти")}</span>
                        </Button>
                        <Button
                          variant="secondary"
                          size="icon"
                          onClick={() => handleRemoveOrLogout(p.key, acc.id, acc.managed)}
                          disabled={busyKey !== null}
                          title={t("Удалить аккаунт")}
                          aria-label={t("Удалить аккаунт")}
                          className="text-[var(--danger)]"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader>
            <div className="flex items-center gap-2">
              <Terminal className="size-3.5 text-[var(--fg-muted)]" />
              <PanelTitle>{t("Custom ACP агенты")}</PanelTitle>
            </div>
            <PanelDescription className="order-3 w-full">
              {t("Любой сторонний ACP-совместимый CLI: команда, аргументы и метод авторизации.")}
            </PanelDescription>
          </PanelHeader>

          {settings.customAcpAgents.length > 0 && (
            <div className="divide-y border-b">
              {settings.customAcpAgents.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[12px]">
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--fg)]">{c.name}</div>
                    <div className="truncate text-[11px] text-[var(--fg-subtle)]">
                      {c.command} {c.args.join(" ")}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="icon"
                    onClick={() => handleDeleteCustomAcp(c.id)}
                    aria-label={t("Удалить агента")}
                    className="text-[var(--danger)]"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="px-4 pt-3">
            <Select
              value=""
              onChange={(id) => {
                const preset = ACP_PRESETS.find((p) => p.id === id);
                if (!preset) return;
                setNewAcpName(preset.name);
                setNewAcpCmd(preset.command);
                setNewAcpArgs(preset.args);
              }}
              placeholder={t("Добавить из каталога…")}
              ariaLabel={t("Каталог ACP-агентов")}
              options={ACP_PRESETS.map((p) => ({
                value: p.id,
                label: p.name,
                hint: `${p.command} ${p.args}`,
              }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 p-4 md:grid-cols-4">
            <Input
              value={newAcpName}
              onChange={(e) => setNewAcpName(e.target.value)}
              placeholder={t("Название")}
              aria-label={t("Название агента")}
            />
            <Input
              value={newAcpCmd}
              onChange={(e) => setNewAcpCmd(e.target.value)}
              placeholder={t("Команда или путь к exe")}
              aria-label={t("Команда агента")}
            />
            <Input
              value={newAcpArgs}
              onChange={(e) => setNewAcpArgs(e.target.value)}
              placeholder={t("Аргументы")}
              aria-label={t("Аргументы")}
            />
            <div className="flex gap-2">
              <Input
                value={newAcpAuth}
                onChange={(e) => setNewAcpAuth(e.target.value)}
                placeholder="Auth ID"
                className="flex-1"
                aria-label="Auth ID"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleAddCustomAcp}
                disabled={!newAcpName.trim() || !newAcpCmd.trim()}
              >
                <Plus className="size-3.5" />
                <span>{t("Добавить")}</span>
              </Button>
            </div>
          </div>
        </Panel>

        <ExternalProvidersPanel settings={settings} onSaveSettings={onSaveSettings} />
      </div>
    </div>
  );
};
