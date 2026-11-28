import React from "react";
import { Search } from "lucide-react";
import { cn } from "./Button";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-7.5 w-full rounded-[6px] border border-transparent bg-[var(--bg-subtle)] px-2.5 text-[12px] text-[var(--fg)] placeholder:text-[var(--fg-subtle)] transition-colors hover:bg-[var(--bg-hover)] focus:border-[var(--border-strong)] focus:bg-[var(--bg-elevated)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  containerClassName?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({ containerClassName, className, ...props }) => (
  <div className={cn("relative", containerClassName)}>
    <Search className="pointer-events-none size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
    <Input className={cn("pl-8", className)} {...props} />
  </div>
);

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-[6px] border border-transparent bg-[var(--bg-subtle)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--fg)] placeholder:text-[var(--fg-subtle)] transition-colors hover:bg-[var(--bg-hover)] focus:border-[var(--border-strong)] focus:bg-[var(--bg-elevated)] disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
