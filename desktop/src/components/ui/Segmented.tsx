import React from "react";
import { cn } from "./Button";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentedOption<T>>;
  className?: string;
}

export function Segmented<T extends string>({ value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex items-center gap-0.5 rounded-[6px] bg-[var(--bg-subtle)] p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium transition-colors duration-100 tabular-nums",
              active
                ? "bg-[var(--bg-elevated)] text-[var(--fg)] shadow-[var(--shadow-raised)]"
                : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
