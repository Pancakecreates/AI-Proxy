import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExternalLink, Power, RotateCw } from "lucide-react";
import { Switch } from "./components/ui/Switch";
import type { AppSettings, ProxyRuntimeStatus } from "./types";

function applyThemeAttrs(s: AppSettings) {
  const html = document.documentElement;
  const resolved =
    s.theme === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : s.theme;
  html.setAttribute("data-theme", resolved);
  html.setAttribute("data-accent", s.accent || "copper");
  html.style.background = "transparent";
  document.body.style.background = "transparent";
}

export const TrayMenu: React.FC = () => {
  const [status, setStatus] = useState<ProxyRuntimeStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    invoke<ProxyRuntimeStatus>("get_proxy_status").then(setStatus).catch(() => {});
    invoke<AppSettings>("get_settings")
      .then((s) => {
        setSettings(s);
        applyThemeAttrs(s);
      })
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const u1 = listen<ProxyRuntimeStatus>("proxy-status-updated", (ev) => {
      if (ev.payload && typeof ev.payload.running === "boolean") {
        setStatus(ev.payload);
      } else {
        invoke<ProxyRuntimeStatus>("get_proxy_status").then(setStatus).catch(() => {});
      }
    });
    const u2 = listen<AppSettings>("settings-updated", (ev) => {
      if (ev.payload) {
        setSettings(ev.payload);
        applyThemeAttrs(ev.payload);
      }
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        getCurrentWindow().hide().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      u1.then((f) => f()).catch(() => {});
      u2.then((f) => f()).catch(() => {});
    };
  }, []);

  const running = status?.running ?? false;
  const starting = status?.starting ?? false;

  const hideTray = () => {
    getCurrentWindow().hide().catch(() => {});
  };

  const handleOpen = async () => {
    await invoke("show_main_window").catch(() => {});
  };

  const handleToggle = async () => {
    if (busy || starting) return;
    setBusy(true);
    try {
      const next = running
        ? await invoke<ProxyRuntimeStatus>("stop_proxy")
        : await invoke<ProxyRuntimeStatus>("start_proxy");
      setStatus(next);
    } finally {
      setBusy(false);
      hideTray();
    }
  };

  const handleRestart = async () => {
    if (busy || starting) return;
    setBusy(true);
    try {
      const next = await invoke<ProxyRuntimeStatus>("restart_proxy");
      setStatus(next);
    } finally {
      setBusy(false);
      hideTray();
    }
  };

  const handleQuit = async () => {
    await invoke("quit_app").catch(() => {});
  };

  return (
    <div className="h-dvh w-screen p-1.5 select-none bg-transparent">
      <div className="h-full w-full rounded-[12px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[0_10px_28px_rgba(0,0,0,0.42)] flex flex-col overflow-hidden">
        <div className="px-3 py-2.5 border-b bg-[var(--sidebar-bg)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-[var(--bg-subtle)] border border-[var(--border-strong)]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 7L18 12L6 17"
                  stroke="var(--accent)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="6" cy="7" r="2.3" fill="var(--fg)" />
                <circle cx="6" cy="17" r="2.3" fill="var(--fg)" />
                <circle cx="18" cy="12" r="2.6" fill="var(--accent)" />
              </svg>
            </div>
            <span className="text-[12.5px] font-semibold tracking-[-0.015em] text-[var(--fg)] truncate">
              AI Proxy
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums ${
              starting
                ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                : running
                  ? "bg-[var(--success-soft)] text-[var(--success)]"
                  : "bg-[var(--bg-subtle)] text-[var(--fg-muted)]"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                starting
                  ? "bg-[var(--warning)] animate-pulse"
                  : running
                    ? "bg-[var(--success)]"
                    : "bg-[var(--fg-subtle)]"
              }`}
            />
            {starting ? "Запуск" : running ? `${status?.modelsCount ?? 0} мод.` : "Остановлен"}
          </span>
        </div>

        {settings && (
          <div className="px-3 py-1.5 border-b bg-[var(--bg)]/60 flex items-center gap-2 text-[10.5px] text-[var(--fg-muted)] tabular-nums">
            <span className="inline-flex items-center gap-1">
              <span
                className={`size-1.5 rounded-full ${
                  running && settings.enableAnthropic ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                }`}
              />
              Anthropic :{settings.anthropicPort}
            </span>
            <span className="text-[var(--border-strong)]">·</span>
            <span className="inline-flex items-center gap-1">
              <span
                className={`size-1.5 rounded-full ${
                  running && settings.enableOpenai ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                }`}
              />
              OpenAI :{settings.openaiPort}
            </span>
          </div>
        )}

        <div className="p-1.5 flex-1 flex flex-col justify-between">
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={handleOpen}
              className="w-full flex items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--bg-subtle)] transition-colors text-left"
            >
              <ExternalLink className="size-3.5 text-[var(--fg-muted)] shrink-0" />
              <span>Открыть окно</span>
            </button>

            <div className="flex items-center justify-between gap-2 rounded-[7px] px-2.5 py-1.5">
              <span className="text-xs font-medium text-[var(--fg)]">Прокси</span>
              <Switch
                checked={running}
                disabled={busy || starting}
                onCheckedChange={() => void handleToggle()}
              />
            </div>

            {running && (
              <button
                type="button"
                onClick={handleRestart}
                disabled={busy || starting}
                className="w-full flex items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] disabled:opacity-50 transition-colors text-left"
              >
                <RotateCw className="size-3.5 shrink-0" />
                <span>Перезапустить</span>
              </button>
            )}
          </div>

          <div className="pt-1 mt-1 border-t">
            <button
              type="button"
              onClick={handleQuit}
              className="w-full flex items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-soft)] transition-colors text-left"
            >
              <Power className="size-3.5 shrink-0" />
              <span>Выход</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
