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
import { Badge, Button } from "./components/ui";

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
      className="flex h-10 shrink-0 items-center justify-between border-b bg-[var(--sidebar-bg)] pl-3 pr-0 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2.5 min-w-0">
        <div
          data-tauri-drag-region
          className="flex size-5 items-center justify-center rounded-[6px] bg-[var(--bg-subtle)] border border-[var(--border-strong)]"
        >
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
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-[-0.015em] text-[var(--fg)]">
          AI Proxy
        </span>
        <Badge
          variant={starting ? "warning" : running ? "success" : "neutral"}
          className="rounded-full px-2 py-0.5 text-[11px]"
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
          {starting ? "Запуск..." : running ? `Активен · ${status?.modelsCount ?? 0} мод.` : "Остановлен"}
        </Badge>
      </div>

      <div className="flex h-full items-center gap-1">
        {updateInfo?.hasUpdate && (
          <button
            type="button"
            onClick={onOpenUpdates}
            title={`Доступна версия v${updateInfo.latestVersion}`}
            className="mr-1 inline-flex h-6 items-center gap-1 rounded-full border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-2 text-[11px] font-medium text-[var(--accent)] hover:brightness-110 transition-all"
          >
            <ArrowDownToLine className="size-3" />
            <span>v{updateInfo.latestVersion}</span>
          </button>
        )}

        <Button
          variant={running ? "secondary" : "primary"}
          size="xs"
          onClick={onToggleProxy}
          disabled={starting}
          className="mr-1 h-6.5"
        >
          {starting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : running ? (
            <StopIcon className="size-3 fill-current" />
          ) : (
            <Play className="size-3 fill-current" />
          )}
          <span>{running ? "Стоп" : "Старт"}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onCycleTheme}
          title={`Тема: ${theme === "auto" ? "Авто" : theme === "dark" ? "Тёмная" : "Светлая"}`}
          aria-label="Переключить тему"
          className="size-7"
        >
          {theme === "auto" ? (
            <Monitor className="size-3.5" />
          ) : theme === "dark" ? (
            <Moon className="size-3.5" />
          ) : (
            <Sun className="size-3.5" />
          )}
        </Button>

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
