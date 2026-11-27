import React from "react";
import { cn } from "./Button";

export type BadgeVariant = "neutral" | "subtle" | "accent" | "success" | "warning" | "danger" | "mono";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const BADGE_CLASSES: Record<BadgeVariant, string> = {
  neutral: "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)]",
  subtle: "border border-transparent bg-[var(--bg-subtle)] text-[var(--fg-muted)]",
  accent: "border border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[var(--accent)]",
  success: "border border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]",
  warning: "border border-[var(--warning)]/30 bg-[var(--warning-soft)] text-[var(--warning)]",
  danger: "border border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]",
  mono: "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)]",
};

export const Badge: React.FC<BadgeProps> = ({ variant = "neutral", className, ...props }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap tabular-nums",
      BADGE_CLASSES[variant],
      className,
    )}
    {...props}
  />
);
