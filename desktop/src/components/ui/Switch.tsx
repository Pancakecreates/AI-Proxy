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
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-40",
        checked ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0_/_0.25)] transition-transform duration-150",
          checked ? "translate-x-[13px]" : "translate-x-[2px]",
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
        "flex items-center justify-between gap-3 rounded-[6px] px-2 py-1.5 transition-colors select-none",
        !disabled && "cursor-pointer hover:bg-[var(--bg-subtle)]",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-[var(--fg)]">{label}</div>
        {description && <div className="text-[11px] text-[var(--fg-subtle)]">{description}</div>}
      </div>
      <div onClick={(e) => e.stopPropagation()}>{control}</div>
    </div>
  );
};
