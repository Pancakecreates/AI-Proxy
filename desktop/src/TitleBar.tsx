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
  RotateCcw,
} from "lucide-react";
import type { AppUpdateInfo, ProxyRuntimeStatus, UpdateDownloadState } from "./types";
import { useI18n } from "./i18n";
import { Button } from "./components/ui";

interface TitleBarProps {
  status: ProxyRuntimeStatus | null;
  theme: "auto" | "dark" | "light";
  updateInfo: AppUpdateInfo | null;
  updateDownload: UpdateDownloadState | null;
  onRestartToUpdate: () => void;
  onOpenUpdates: () => void;
  onCycleTheme: () => void;
  onToggleProxy: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  status,
  theme,
  updateInfo,
  updateDownload,
  onRestartToUpdate,
  onOpenUpdates,
  onCycleTheme,
  onToggleProxy,
}) => {
  const { t } = useI18n();
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
      className="flex h-11 shrink-0 items-center justify-between border-b bg-[var(--sidebar-bg)] pl-3.5 pr-0 select-none"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
          <path
            d="M5.5 7.5L18 12L5.5 16.5"
            stroke="var(--accent)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="5.5" cy="7.5" r="2.1" fill="var(--fg-muted)" />
          <circle cx="5.5" cy="16.5" r="2.1" fill="var(--fg-muted)" />
          <circle cx="18" cy="12" r="2.4" fill="var(--accent)" />
        </svg>
        <span data-tauri-drag-region className="text-[12.5px] font-semibold tracking-[-0.01em] text-[var(--fg)]">
          AI Proxy
        </span>
      </div>

      <div className="flex h-full items-center gap-1">
        {updateDownload?.ready ? (
          <button
            type="button"
            onClick={onRestartToUpdate}
            title={t("Установить v{v} и перезапустить", { v: updateDownload.version })}
            className="mr-1 inline-flex h-6.5 items-center gap-1.5 rounded-[5px] bg-[var(--accent)] px-2 text-[11px] font-medium text-[var(--accent-fg)] transition-[filter] hover:brightness-110"
          >
            <RotateCcw className="size-3" />
            <span>{t("Перезапустить")}</span>
          </button>
        ) : updateDownload?.downloading ? (
          <span
            title={updateDownload.message}
            className="mr-1 inline-flex h-6.5 items-center gap-1.5 rounded-[5px] bg-[var(--accent-soft)] px-2 text-[11px] font-medium tabular-nums text-[var(--accent)]"
          >
            <Loader2 className="size-3 animate-spin" />
            <span>{Math.round(updateDownload.percent)}%</span>
          </span>
        ) : updateInfo?.hasUpdate ? (
          <button
            type="button"
            onClick={onOpenUpdates}
            title={t("Доступна версия v{v}", { v: updateInfo.latestVersion })}
            className="mr-1 inline-flex h-6.5 items-center gap-1 rounded-[5px] bg-[var(--accent-soft)] px-1.5 text-[11px] font-medium text-[var(--accent)] transition-[filter] hover:brightness-110"
          >
            <ArrowDownToLine className="size-3" />
            <span>v{updateInfo.latestVersion}</span>
          </button>
        ) : null}

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
            <StopIcon className="size-2.5 fill-current" />
          ) : (
            <Play className="size-2.5 fill-current" />
          )}
          <span>{running ? t("Стоп") : t("Старт")}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={onCycleTheme}
          title={t("Тема: {theme}", { theme: theme === "auto" ? t("Авто") : theme === "dark" ? t("Тёмная") : t("Светлая") })}
          aria-label={t("Переключить тему")}
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

        <div className="ml-1.5 flex h-full items-center border-l">
          <button
            type="button"
            onClick={handleMinimize}
            aria-label={t("Свернуть")}
            data-press="none"
            className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleToggleMax}
            aria-label={maximized ? t("Восстановить") : t("Развернуть")}
            data-press="none"
            className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
          >
            {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t("Закрыть")}
            data-press="none"
            className="inline-flex h-full w-[46px] items-center justify-center text-[var(--fg-muted)] transition-colors hover:bg-[#c42b1c] hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
