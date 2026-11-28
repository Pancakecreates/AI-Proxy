import React, { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "./Button";

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  className,
  ariaLabel,
}) => {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
  }, [value]);

  const clamp = (v: number) => {
    let next = v;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      onChange(clamp(parsed));
    } else {
      setText(null);
    }
  };

  const bump = (dir: 1 | -1) => {
    onChange(clamp(value + dir * step));
  };

  const stepperButton =
    "inline-flex h-full w-7 shrink-0 items-center justify-center text-[var(--fg-subtle)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      className={cn(
        "flex h-7.5 w-full items-stretch overflow-hidden rounded-[6px] border border-transparent bg-[var(--bg-subtle)] transition-colors focus-within:border-[var(--border-strong)] focus-within:bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]",
        disabled && "opacity-50",
        className,
      )}
    >
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        disabled={disabled}
        value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const raw = Number((e.target as HTMLInputElement).value);
            const base = Number.isFinite(raw) ? raw : value;
            const dir = e.key === "ArrowUp" ? 1 : -1;
            onChange(clamp(base + dir * step));
          } else if (e.key === "Enter") {
            commit((e.target as HTMLInputElement).value);
          }
        }}
        className="h-full w-full min-w-0 bg-transparent px-2.5 text-[12px] tabular-nums text-[var(--fg)] outline-none"
      />
      <div className="flex shrink-0 items-stretch border-l border-[var(--border)]">
        <button
          type="button"
          tabIndex={-1}
          aria-label="−"
          disabled={disabled || (min !== undefined && value <= min)}
          onClick={() => bump(-1)}
          className={stepperButton}
        >
          <Minus className="size-3" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="+"
          disabled={disabled || (max !== undefined && value >= max)}
          onClick={() => bump(1)}
          className={cn(stepperButton, "border-l border-[var(--border)]")}
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  );
};
