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
    "bg-[var(--accent)] text-[var(--accent-fg)] border border-transparent hover:brightness-[1.07]",
  secondary:
    "bg-[var(--bg-elevated)] text-[var(--fg)] border border-[var(--border)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-strong)]",
  ghost:
    "bg-transparent text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]",
  danger:
    "bg-transparent text-[var(--danger)] border border-transparent hover:bg-[var(--danger-soft)]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: "h-6.5 px-2 text-[11px] gap-1.5 rounded-[5px]",
  sm: "h-7.5 px-2.5 text-[12px] gap-1.5 rounded-[6px]",
  md: "h-9 px-3 text-[12.5px] gap-2 rounded-[7px]",
  icon: "size-7.5 p-0 justify-center rounded-[6px]",
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
      "inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-100 select-none disabled:pointer-events-none disabled:opacity-40",
      VARIANT_CLASSES[variant],
      SIZE_CLASSES[size],
      className,
    )}
    {...props}
  />
);
