import React from "react";
import { cn } from "./Button";

export const Panel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn("surface-panel rounded-[10px]", className)} {...props} />
);

export const PanelHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={cn("flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3", className)}
    {...props}
  />
);

export const PanelTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({ className, ...props }) => (
  <h2 className={cn("text-[13px] font-semibold tracking-[-0.01em] text-[var(--fg)]", className)} {...props} />
);

export const PanelDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({ className, ...props }) => (
  <p className={cn("text-[11px] text-[var(--fg-muted)] text-pretty", className)} {...props} />
);
