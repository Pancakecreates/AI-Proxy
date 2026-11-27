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
import { readQuotaCache, refreshQuotas } from "./quotaCache";
import {
  Button,
  Input,
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
  Switch,
} from "./components/ui";

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

export const AccountsView: React.FC<AccountsViewProps> = ({
  settings,
  runtimes,
  onRefreshAll,
  onSaveSettings,
}) => {
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
      setFeedback({ kind: "ok", text: `CLI ${provider} установлен: ${installedPath}` });
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

  const handleAddAgyAccount = async () => {
    setBusyKey("add-agy");
    setFeedback(null);
    try {
      const acc = await invoke("add_antigravity_account", { label: null });
      setFeedback({ kind: "ok", text: `Добавлен аккаунт Antigravity: ${(acc as { label: string }).label}` });
      onRefreshAll();
      await loadQuotas();
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setBusyKey(null);
    }
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
      setFeedback({ kind: "ok", text: `Аккаунт ${provider} отключён` });
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
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.02em]">Аккаунты, вход, лимиты и CLI</h1>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5">
              Подключение аккаунтов внутри приложения, проверка квот и автоустановка недостающих движков ACP и CLI.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleAddAgyAccount} disabled={busyKey !== null}>
              <Plus className="size-3.5" />
              <span>Добавить аккаунт Antigravity</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => loadQuotas()} disabled={loadingQuotas}>
              <RefreshCw className={`size-3.5 ${loadingQuotas ? "animate-spin" : ""}`} />
              <span>Проверить лимиты</span>
            </Button>
          </div>
        </div>

        {feedback && (
          <div
            className={`rounded-[9px] border px-4 py-2.5 text-xs flex items-center gap-2 ${
              feedback.kind === "ok"
                ? "border-[var(--success)]/35 bg-[var(--success-soft)] text-[var(--success)]"
                : "border-[var(--danger)]/35 bg-[var(--danger-soft)] text-[var(--danger)]"
            }`}
          >
            {feedback.kind === "ok" ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : (
              <AlertCircle className="size-4 shrink-0" />
            )}
            <span className="break-all">{feedback.text}</span>
          </div>
        )}

        <Panel className="overflow-hidden">
          <PanelHeader>
            <div className="flex items-center gap-2">
              <BrandIcon brand="gemini" size={18} />
              <PanelTitle>Аккаунты Antigravity и лимиты</PanelTitle>
            </div>
            <span className="text-[11px] text-[var(--fg-muted)] tabular-nums">
              Найдено: {agyAccounts.length}
            </span>
          </PanelHeader>
          <div className="divide-y">
            {agyAccounts.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--fg-muted)]">
                Аккаунты Antigravity не найдены. Нажмите «Добавить аккаунт Antigravity», чтобы войти через Google.
              </div>
            ) : (
              agyAccounts.map((acc, idx) => {
                const quota = quotas.find((q) => q.accountKey === `antigravity:${acc.id}`);
                return (
                  <div key={acc.id} className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="inline-flex size-6 items-center justify-center rounded-full border bg-[var(--bg)] text-[11px] font-semibold tabular-nums text-[var(--fg-muted)]">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium truncate text-[var(--fg)]">
                            {quota?.email || acc.email || acc.label}
                          </div>
                          <div className="text-[11px] text-[var(--fg-subtle)] truncate">
                            {acc.geminiDir}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {quota?.verificationUrl && (
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => openUrl(quota.verificationUrl!).catch(() => {})}
                            className="border-[var(--warning)]/40 bg-[var(--warning-soft)] text-[var(--warning)]"
                          >
                            <ExternalLink className="size-3" />
                            <span>Подтвердить аккаунт</span>
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => handleLogin("antigravity", acc.id)}
                          disabled={busyKey !== null}
                        >
                          <LogIn className="size-3" />
                          <span>Обновить вход</span>
                        </Button>
                        <Button
                          variant="danger"
                          size="xs"
                          onClick={() => handleRemoveOrLogout("antigravity", acc.id, acc.managed)}
                          disabled={busyKey !== null}
                        >
                          <Trash2 className="size-3" />
                          <span>Удалить</span>
                        </Button>
                      </div>
                    </div>

                    {quota?.error && <div className="text-[11px] text-[var(--fg-muted)]">{quota.error}</div>}

                    {quota && quota.windows.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                        {quota.windows.map((w, wi) => (
                          <div key={wi} className="rounded-[8px] border bg-[var(--bg)] p-2.5 space-y-1.5">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="font-medium truncate">{w.label}</span>
                              <span className="tabular-nums text-[var(--fg-muted)]">
                                Осталось {w.remainingPercent.toFixed(0)}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                                style={{ width: `${Math.max(2, Math.min(100, w.remainingPercent))}%` }}
                              />
                            </div>
                            {w.resetsAt && (
                              <div className="text-[10px] text-[var(--fg-subtle)] tabular-nums">
                                Сброс: {new Date(w.resetsAt).toLocaleString()}
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
            <Panel key={cq.accountKey} className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <BrandIcon brand="openai" size={18} />
                  <div>
                    <div className="text-[13px] font-semibold tracking-[-0.01em]">Codex (ChatGPT) — лимиты</div>
                    <div className="text-[11px] text-[var(--fg-muted)]">
                      {cq.signedIn ? cq.email || "Авторизован" : "Не выполнен вход"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => handleLogin("codex")}
                    disabled={busyKey !== null}
                  >
                    <LogIn className="size-3" />
                    <span>Войти</span>
                  </Button>
                  <Button
                    variant="danger"
                    size="xs"
                    onClick={() => handleRemoveOrLogout("codex")}
                    disabled={busyKey !== null}
                  >
                    <LogOut className="size-3" />
                    <span>Выйти</span>
                  </Button>
                </div>
              </div>
              {cq.windows.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {cq.windows.map((w, i) => (
                    <div key={i} className="rounded-[8px] border bg-[var(--bg)] p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-medium">{w.label}</span>
                        <span className="tabular-nums text-[var(--fg-muted)]">
                          Использовано {w.usedPercent.toFixed(0)}% · Осталось {w.remainingPercent.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${Math.max(2, Math.min(100, w.remainingPercent))}%` }}
                        />
                      </div>
                      {w.resetsAt && (
                        <div className="text-[10px] text-[var(--fg-subtle)] tabular-nums">
                          Сброс: {new Date(w.resetsAt).toLocaleString()}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          ))}

        <Panel className="overflow-hidden">
          <PanelHeader className="flex-col items-start gap-0.5">
            <PanelTitle>Провайдеры и установка CLI</PanelTitle>
            <PanelDescription>
              Включайте нужные движки, скачивайте отсутствующие CLI в один клик и авторизуйтесь прямо из окна.
            </PanelDescription>
          </PanelHeader>
          <div className="divide-y">
            {PROVIDERS_CATALOG.map((p) => {
              const exe = getRuntimePath(p.key);
              const enabled = Boolean(settings[p.enableKey]);
              const prog = installProgress[p.key];
              const isBusy = busyKey === `dl-${p.key}` || busyKey === `login-${p.key}-`;
              return (
                <div
                  key={p.key}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-[var(--density-cell-y)] text-xs hover:bg-[var(--bg-subtle)]/35 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <BrandIcon brand={p.brand} size={20} />
                    <div className="min-w-0">
                      <div className="font-medium text-[13px]">{p.name}</div>
                      <div className="text-[11px] text-[var(--fg-subtle)] truncate max-w-md">
                        {prog && prog.status !== "done"
                          ? `${prog.message} (${Math.round(prog.progressPercent)}%)`
                          : exe || "CLI не найден на диске"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!exe && p.downloadable && (
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => handleDownload(p.key)}
                        disabled={busyKey !== null}
                      >
                        <Download className="size-3" />
                        <span>{isBusy ? "Установка..." : "Скачать CLI"}</span>
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
                        <span>Войти</span>
                      </Button>
                    )}

                    {exe && ["devin", "grok", "codex"].includes(p.key) && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleRemoveOrLogout(p.key)}
                        disabled={busyKey !== null}
                        title="Выйти из аккаунта"
                        aria-label="Выйти из аккаунта"
                        className="hover:text-[var(--danger)]"
                      >
                        <LogOut className="size-3" />
                      </Button>
                    )}

                    <div className="pl-1">
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggleProvider(p.enableKey, enabled)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel className="p-4 space-y-4">
          <div className="flex items-center gap-2.5">
            <Terminal className="size-4 text-[var(--fg-muted)]" />
            <div>
              <PanelTitle>Custom ACP агенты</PanelTitle>
              <PanelDescription>
                Подключайте любой сторонний ACP-совместимый CLI агент (команда + аргументы).
              </PanelDescription>
            </div>
          </div>

          {settings.customAcpAgents.length > 0 && (
            <div className="divide-y rounded-[8px] border bg-[var(--bg)]">
              {settings.customAcpAgents.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-[11px] text-[var(--fg-subtle)] truncate">
                      {c.command} {c.args.join(" ")}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteCustomAcp(c.id)}
                    aria-label="Удалить агента"
                    className="size-7 hover:text-[var(--danger)]"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <Input
              value={newAcpName}
              onChange={(e) => setNewAcpName(e.target.value)}
              placeholder="Название (напр. My Agent)"
            />
            <Input
              value={newAcpCmd}
              onChange={(e) => setNewAcpCmd(e.target.value)}
              placeholder="Команда или путь к exe"
            />
            <Input
              value={newAcpArgs}
              onChange={(e) => setNewAcpArgs(e.target.value)}
              placeholder="Аргументы (напр. acp)"
            />
            <div className="flex gap-2">
              <Input
                value={newAcpAuth}
                onChange={(e) => setNewAcpAuth(e.target.value)}
                placeholder="Auth ID"
                className="flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleAddCustomAcp}
                disabled={!newAcpName.trim() || !newAcpCmd.trim()}
              >
                <Plus className="size-3.5" />
                <span>Добавить</span>
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
};
