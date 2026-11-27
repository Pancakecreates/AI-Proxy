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
  const [quotas, setQuotas] = useState<AccountQuotaReport[]>([]);
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<Record<string, RuntimeInstallProgress>>({});
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newAcpName, setNewAcpName] = useState("");
  const [newAcpCmd, setNewAcpCmd] = useState("");
  const [newAcpArgs, setNewAcpArgs] = useState("acp");
  const [newAcpAuth, setNewAcpAuth] = useState("");

  const loadQuotas = async () => {
    setLoadingQuotas(true);
    try {
      const res = await invoke<AccountQuotaReport[]>("get_accounts_and_quotas");
      setQuotas(res);
    } catch (e) {
      setFeedback({ kind: "err", text: String(e) });
    } finally {
      setLoadingQuotas(false);
    }
  };

  useEffect(() => {
    loadQuotas();
    const unlisten = listen<RuntimeInstallProgress>("runtime-install-progress", (ev) => {
      setInstallProgress((prev) => ({ ...prev, [ev.payload.provider]: ev.payload }));
    });
    return () => {
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
      id: newAcpName
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
    await onSaveSettings(
      { ...settings, customAcpAgents: [...settings.customAcpAgents, item] },
      true
    );
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
      true
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
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Аккаунты, вход, лимиты и CLI</h1>
            <p className="text-xs text-[var(--fg-muted)]">
              Подключение аккаунтов внутри приложения, проверка квот и автоустановка недостающих ACP/CLI движков.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAddAgyAccount}
              disabled={busyKey !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="size-3.5" />
              <span>Добавить аккаунт Antigravity</span>
            </button>
            <button
              type="button"
              onClick={loadQuotas}
              disabled={loadingQuotas}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-[var(--bg-elevated)] px-3 text-xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              <RefreshCw className={`size-3.5 ${loadingQuotas ? "animate-spin" : ""}`} />
              <span>Проверить лимиты</span>
            </button>
          </div>
        </div>

        {feedback && (
          <div
            className={`rounded-lg border px-4 py-2.5 text-xs flex items-center gap-2 ${
              feedback.kind === "ok"
                ? "border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]"
                : "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]"
            }`}
          >
            {feedback.kind === "ok" ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertCircle className="size-4 shrink-0" />}
            <span className="break-all">{feedback.text}</span>
          </div>
        )}

        <section className="rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
          <div className="border-b px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrandIcon brand="gemini" size={18} />
              <h2 className="text-sm font-semibold">Аккаунты Antigravity и лимиты</h2>
            </div>
            <span className="text-[11px] text-[var(--fg-muted)] tabular-nums">
              Найдено: {agyAccounts.length}
            </span>
          </div>
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
                        <span className="inline-flex size-6 items-center justify-center rounded-full bg-[var(--bg-subtle)] text-[11px] font-semibold tabular-nums">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">
                            {quota?.email || acc.email || acc.label}
                          </div>
                          <div className="text-[11px] text-[var(--fg-subtle)] font-mono truncate">
                            {acc.geminiDir}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {quota?.verificationUrl && (
                          <button
                            type="button"
                            onClick={() => openUrl(quota.verificationUrl!).catch(() => {})}
                            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2.5 text-[11px] text-[var(--warning)]"
                          >
                            <ExternalLink className="size-3" />
                            <span>Подтвердить аккаунт</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleLogin("antigravity", acc.id)}
                          disabled={busyKey !== null}
                          className="inline-flex h-7 items-center gap-1 rounded border bg-[var(--bg)] px-2.5 text-[11px] hover:bg-[var(--bg-subtle)]"
                        >
                          <LogIn className="size-3" />
                          <span>Обновить вход</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveOrLogout("antigravity", acc.id, acc.managed)}
                          disabled={busyKey !== null}
                          className="inline-flex h-7 items-center gap-1 rounded border px-2.5 text-[11px] text-[var(--danger)] hover:bg-[var(--danger)]/10"
                        >
                          <Trash2 className="size-3" />
                          <span>Удалить</span>
                        </button>
                      </div>
                    </div>

                    {quota?.error && (
                      <div className="text-[11px] text-[var(--fg-muted)]">{quota.error}</div>
                    )}

                    {quota && quota.windows.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                        {quota.windows.map((w, wi) => (
                          <div key={wi} className="rounded-md border bg-[var(--bg)] p-2.5 space-y-1.5">
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
        </section>

        {quotas.filter((q) => q.provider === "codex").map((cq) => (
          <section key={cq.accountKey} className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <BrandIcon brand="openai" size={18} />
                <div>
                  <div className="text-sm font-semibold">Codex (ChatGPT) — лимиты</div>
                  <div className="text-[11px] text-[var(--fg-muted)]">
                    {cq.signedIn ? cq.email || "Авторизован" : "Не выполнен вход"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleLogin("codex")}
                  disabled={busyKey !== null}
                  className="inline-flex h-7 items-center gap-1 rounded border bg-[var(--bg)] px-2.5 text-[11px] hover:bg-[var(--bg-subtle)]"
                >
                  <LogIn className="size-3" />
                  <span>Войти</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveOrLogout("codex")}
                  disabled={busyKey !== null}
                  className="inline-flex h-7 items-center gap-1 rounded border px-2.5 text-[11px] text-[var(--danger)] hover:bg-[var(--danger)]/10"
                >
                  <LogOut className="size-3" />
                  <span>Выйти</span>
                </button>
              </div>
            </div>
            {cq.windows.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {cq.windows.map((w, i) => (
                  <div key={i} className="rounded-md border bg-[var(--bg)] p-2.5 space-y-1.5">
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
          </section>
        ))}

        <section className="rounded-lg border bg-[var(--bg-elevated)] overflow-hidden">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Провайдеры OpenBot и установка CLI</h2>
            <p className="text-[11px] text-[var(--fg-muted)]">
              Включайте нужные движки, скачивайте отсутствующие CLI в один клик и авторизуйтесь прямо из окна.
            </p>
          </div>
          <div className="divide-y">
            {PROVIDERS_CATALOG.map((p) => {
              const exe = getRuntimePath(p.key);
              const enabled = Boolean(settings[p.enableKey]);
              const prog = installProgress[p.key];
              const isBusy = busyKey === `dl-${p.key}` || busyKey === `login-${p.key}-`;
              return (
                <div key={p.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <BrandIcon brand={p.brand} size={20} />
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{p.name}</div>
                      <div className="text-[11px] text-[var(--fg-subtle)] font-mono truncate max-w-md">
                        {prog && prog.status !== "done"
                          ? `${prog.message} (${Math.round(prog.progressPercent)}%)`
                          : exe || "CLI не найден на диске"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!exe && p.downloadable && (
                      <button
                        type="button"
                        onClick={() => handleDownload(p.key)}
                        disabled={busyKey !== null}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-[11px] font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-50"
                      >
                        <Download className="size-3" />
                        <span>{isBusy ? "Установка..." : "Скачать CLI"}</span>
                      </button>
                    )}

                    {exe && p.loginable && (
                      <button
                        type="button"
                        onClick={() => handleLogin(p.key)}
                        disabled={busyKey !== null}
                        className="inline-flex h-7 items-center gap-1 rounded border bg-[var(--bg)] px-2.5 text-[11px] hover:bg-[var(--bg-subtle)]"
                      >
                        <LogIn className="size-3" />
                        <span>Войти</span>
                      </button>
                    )}

                    {exe && ["devin", "grok", "codex"].includes(p.key) && (
                      <button
                        type="button"
                        onClick={() => handleRemoveOrLogout(p.key)}
                        disabled={busyKey !== null}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] text-[var(--fg-muted)] hover:text-[var(--danger)]"
                      >
                        <LogOut className="size-3" />
                      </button>
                    )}

                    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none pl-1">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => handleToggleProvider(p.enableKey, enabled)}
                        className="accent-[var(--accent)] size-3.5"
                      />
                      <span className="text-[11px] font-medium">{enabled ? "Вкл" : "Выкл"}</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border bg-[var(--bg-elevated)] p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-[var(--fg-muted)]" />
            <div>
              <h2 className="text-sm font-semibold">Custom ACP агенты</h2>
              <p className="text-[11px] text-[var(--fg-muted)]">
                Подключайте любой сторонний ACP-совместимый CLI агент (команда + аргументы).
              </p>
            </div>
          </div>

          {settings.customAcpAgents.length > 0 && (
            <div className="divide-y rounded-md border">
              {settings.customAcpAgents.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="font-mono text-[11px] text-[var(--fg-subtle)] truncate">
                      {c.command} {c.args.join(" ")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomAcp(c.id)}
                    className="text-[var(--fg-subtle)] hover:text-[var(--danger)] p-1"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <input
              value={newAcpName}
              onChange={(e) => setNewAcpName(e.target.value)}
              placeholder="Название (напр. My Agent)"
              className="h-8 rounded-md border bg-[var(--bg)] px-2.5 text-xs"
            />
            <input
              value={newAcpCmd}
              onChange={(e) => setNewAcpCmd(e.target.value)}
              placeholder="Команда / путь к exe"
              className="h-8 rounded-md border bg-[var(--bg)] px-2.5 text-xs font-mono"
            />
            <input
              value={newAcpArgs}
              onChange={(e) => setNewAcpArgs(e.target.value)}
              placeholder="Аргументы (напр. acp)"
              className="h-8 rounded-md border bg-[var(--bg)] px-2.5 text-xs font-mono"
            />
            <div className="flex gap-2">
              <input
                value={newAcpAuth}
                onChange={(e) => setNewAcpAuth(e.target.value)}
                placeholder="Auth ID (опц.)"
                className="h-8 flex-1 rounded-md border bg-[var(--bg)] px-2.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={handleAddCustomAcp}
                disabled={!newAcpName.trim() || !newAcpCmd.trim()}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] disabled:opacity-40"
              >
                <Plus className="size-3.5" />
                <span>Добавить</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
