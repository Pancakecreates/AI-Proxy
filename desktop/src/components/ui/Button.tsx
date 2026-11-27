import React from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs));
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "icon";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--accent-fg)] border border-transparent hover:brightness-110 active:translate-y-[0.5px]",
  secondary:
    "bg-[var(--bg-elevated)] text-[var(--fg)] border border-[var(--border)] shadow-[var(--panel-highlight)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] active:translate-y-[0.5px]",
  ghost:
    "bg-transparent text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]",
  danger:
    "bg-transparent text-[var(--danger)] border border-[var(--danger)]/35 hover:bg-[var(--danger-soft)] hover:border-[var(--danger)]/55",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "h-7 px-2.5 text-[11px] gap-1 rounded-[6px]",
  sm: "h-8 px-3 text-xs gap-1.5 rounded-[7px]",
  md: "h-9 px-3.5 text-xs gap-2 rounded-[8px]",
  icon: "size-8 p-0 justify-center rounded-[7px]",
};

export const Button: React.FC<ButtonProps> = ({
  variant = "secondary",
  size = "sm",
  className,
  type = "button",
  ...props
}) => (
  <button
    type={type}
    className={cn(
      "inline-flex shrink-0 items-center justify-center font-medium transition-[background-color,border-color,color,transform,filter] duration-150 select-none disabled:pointer-events-none disabled:opacity-45",
      VARIANT_CLASSES[variant],
      SIZE_CLASSES[size],
      className,
    )}
    {...props}
  />
);
