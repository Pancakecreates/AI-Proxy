import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "./Button";

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
  className?: string;
  iconOnly?: boolean;
  onCopied?: () => void;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label,
  copiedLabel,
  title,
  className,
  iconOnly = false,
  onCopied,
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    onCopied?.();
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const icon = copied ? (
    <Check className="size-3 text-[var(--success)]" />
  ) : (
    <Copy className="size-3" />
  );

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? (copiedLabel ?? title) : title}
        aria-label={title}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] border border-transparent text-[var(--fg-subtle)] transition-colors hover:border-[var(--border)] hover:bg-[var(--bg-elevated)] hover:text-[var(--fg)]",
          copied && "border-[var(--border)] bg-[var(--bg-elevated)]",
          className,
        )}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? (copiedLabel ?? title) : title}
      className={cn(
        "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-[5px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[11px] font-medium text-[var(--fg-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)]",
        className,
      )}
    >
      {icon}
      {label && <span>{copied && copiedLabel ? copiedLabel : label}</span>}
    </button>
  );
};
