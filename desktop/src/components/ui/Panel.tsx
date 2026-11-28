import React from "react";
import { cn } from "./Button";

export const Panel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn("surface-panel rounded-[8px]", className)} {...props} />
);

export const PanelHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={cn("flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5", className)}
    {...props}
  />
);

export const PanelTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({ className, ...props }) => (
  <h2 className={cn("text-[12.5px] font-semibold leading-tight text-[var(--fg)]", className)} {...props} />
);

export const PanelDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({ className, ...props }) => (
  <p className={cn("text-[12px] leading-snug text-[var(--fg-muted)] text-pretty", className)} {...props} />
);

interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, children }) => (
  <div className="page-head">
    <div className="min-w-0">
      <h1 className="page-title">{title}</h1>
      {description && <p className="page-sub">{description}</p>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>
);

export const StatGrid: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={cn(
      "grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4",
      className,
    )}
    {...props}
  />
);

interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueTitle?: string;
}

export const Stat: React.FC<StatProps> = ({ label, value, sub, valueTitle }) => (
  <div className="min-w-0 bg-[var(--bg-elevated)] px-4 py-3.5">
    <div className="text-[12px] font-medium text-[var(--fg-muted)]">{label}</div>
    <div
      className="mt-1.5 text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[var(--fg)]"
      title={valueTitle}
    >
      {value}
    </div>
    {sub && (
      <div className="mt-1.5 text-[12px] leading-snug text-[var(--fg-subtle)] tabular-nums">{sub}</div>
    )}
  </div>
);
