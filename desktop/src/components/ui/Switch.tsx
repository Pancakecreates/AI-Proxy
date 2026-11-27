import React from "react";
import { cn } from "./Button";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  description,
  className,
}) => {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-45",
        checked
          ? "border-transparent bg-[var(--accent)]"
          : "border-[var(--border-strong)] bg-[var(--bg-subtle)]",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-[var(--accent-fg)] shadow-xs transition-transform duration-150",
          checked ? "translate-x-[15px]" : "translate-x-[1px] bg-[var(--fg-muted)]",
        )}
      />
    </button>
  );

  if (!label) return control;

  return (
    <div
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
      className={cn(
        "flex items-center justify-between gap-3 rounded-[8px] border border-transparent px-2.5 py-1.5 transition-colors select-none",
        !disabled && "cursor-pointer hover:bg-[var(--bg-subtle)]/70",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--fg)]">{label}</div>
        {description && <div className="text-[11px] text-[var(--fg-subtle)]">{description}</div>}
      </div>
      <div onClick={(e) => e.stopPropagation()}>{control}</div>
    </div>
  );
};
