import React from "react";
import { cn } from "./Button";

export type BadgeVariant = "neutral" | "subtle" | "accent" | "success" | "warning" | "danger" | "mono";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const BADGE_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-[var(--bg-subtle)] text-[var(--fg-muted)]",
  subtle: "bg-transparent text-[var(--fg-subtle)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
  success: "bg-[var(--success-soft)] text-[var(--success)]",
  warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
  mono: "border border-[var(--border)] bg-transparent text-[var(--fg-muted)]",
};

export const Badge: React.FC<BadgeProps> = ({ variant = "neutral", className, ...props }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-px text-[11px] font-medium leading-[1.4] whitespace-nowrap tabular-nums",
      BADGE_CLASSES[variant],
      className,
    )}
    {...props}
  />
);
