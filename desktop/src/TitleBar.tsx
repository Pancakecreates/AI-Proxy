import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus,
  Square,
  Copy,
  X,
  Play,
  Square as StopIcon,
  Sun,
  Moon,
  Monitor,
  Loader2,
  ArrowDownToLine,
} from "lucide-react";
import type { AppUpdateInfo, ProxyRuntimeStatus } from "./types";

interface TitleBarProps {
  status: ProxyRuntimeStatus | null;
  theme: "auto" | "dark" | "light";
  updateInfo: AppUpdateInfo | null;
  onOpenUpdates: () => void;
  onCycleTheme: () => void;
  onToggleProxy: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  status,
  theme,
  updateInfo,
  onOpenUpdates,
  onCycleTheme,
  onToggleProxy,
}) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleMinimize = () => {
    getCurrentWindow().minimize().catch(() => {});
  };

  const handleToggleMax = async () => {
    const win = getCurrentWindow();
    await win.toggleMaximize().catch(() => {});
    setMaximized(await win.isMaximized().catch(() => false));
  };

  const handleClose = () => {
    getCurrentWindow().close().catch(() => {});
  };

  const running = status?.running ?? false;
  const starting = status?.starting ?? false;

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b bg-[var(--bg-elevated)] pl-3 pr-0 select-none"
    >
      {/* Left: Brand mark + title + live status pill */}
      <div data-tauri-drag-region className="flex items-center gap-2.5 min-w-0">
        <div
          data-tauri-drag-region
          className="flex size-5 items-center justify-center rounded-[5px] bg-[#141518] border border-[var(--border-strong)]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 7L18 12L6 17" stroke="#e57a48" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="6" cy="7" r="2.3" fill="#f4f4f5" />
            <circle cx="6" cy="17" r="2.3" fill="#f4f4f5" />
            <circle cx="18" cy="12" r="2.6" fill="#e57a48" />
          </svg>
        </div>
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-tight text-[var(--fg)]">
          AI Proxy
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--fg-muted)] tabular-nums">
          <span
            className={`size-1.5 rounded-full ${
              starting
                ? "bg-[var(--warning)] animate-pulse"
                : running
                  ? "bg-[var(--success)]"
                  : "bg-[var(--fg-subtle)]"
            }`}
          />
          {starting ? "Запуск..." : running ? `Активен · ${status?.modelsCount ?? 0} мод.` : "Остановлен"}
        </span>
      </div>

      {/* Right: Quick controls + Custom Window Chrome Buttons */}
      <div className="flex h-full items-center gap-1">
        {updateInfo?.hasUpdate && (
          <button
            type="button"
            onClick={onOpenUpdates}
            title={`Доступна версия v${updateInfo.latestVersion}`}
            className="mr-1 inline-flex h-6 items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-2 text-[10px] font-medium text-[var(--accent)] hover:opacity-90"
          >
            <ArrowDownToLine className="size-3" />
            <span>v{updateInfo.latestVersion}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onToggleProxy}
          disabled={starting}
          className={`mr-1 inline-flex h-6.5 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors ${
            running
              ? "border bg-[var(--bg-subtle)] text-[var(--fg)] hover:bg-[var(--border)]"
              : "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90"
          }`}
        >
          {starting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : running ? (
            <StopIcon className="size-3 fill-current" />
          ) : (
            <Play className="size-3 fill-current" />
          )}
          <span>{running ? "Стоп" : "Старт"}</span>
        </button>

        <button
          type="button"
          onClick={onCycleTheme}
          title={`Тема: ${theme === "auto" ? "Авто" : theme === "dark" ? "Тёмная" : "Светлая"}`}
          aria-label="Переключить тему"
          className="inline-flex size-7 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] transition-colors"
        >
          {theme === "auto" ? (
            <Monitor className="size-3.5" />
          ) : theme === "dark" ? (
            <Moon className="size-3.5" />
          ) : (
            <Sun className="size-3.5" />
          )}
        </button>

        <div className="ml-1 flex h-full items-center border-l">
          <button
            type="button"
            onClick={handleMinimize}
            aria-label="Свернуть"
            className="inline-flex h-full w-10 items-center justify-center text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] transition-colors"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleToggleMax}
            aria-label={maximized ? "Восстановить" : "Развернуть"}
            className="inline-flex h-full w-10 items-center justify-center text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] transition-colors"
          >
            {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Закрыть"
            className="inline-flex h-full w-11 items-center justify-center text-[var(--fg-muted)] hover:bg-[#e81123] hover:text-white transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
