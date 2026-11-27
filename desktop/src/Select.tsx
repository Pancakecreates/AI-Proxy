import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  placeholder = "Выбрать...",
  searchable = false,
  searchPlaceholder = "Поиск...",
  emptyLabel = "Ничего не найдено",
  ariaLabel,
  className = "",
  buttonClassName = "",
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useRef(`select-${Math.random().toString(36).slice(2, 9)}`);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const label = typeof o.label === "string" ? o.label : o.value;
      const hint = typeof o.hint === "string" ? o.hint : "";
      return label.toLowerCase().includes(q) || hint.toLowerCase().includes(q);
    });
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  };

  const openMenu = (focusSelected = true) => {
    setOpen(true);
    const idx = focusSelected ? filtered.findIndex((o) => o.value === value) : 0;
    setActiveIndex(idx >= 0 ? idx : 0);
  };

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const moveActive = (delta: number) => {
    if (filtered.length === 0) return;
    let i = activeIndex;
    for (let n = 0; n < filtered.length; n += 1) {
      i = (i + delta + filtered.length) % filtered.length;
      if (!filtered[i]?.disabled) break;
    }
    setActiveIndex(i);
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? moveActive(1) : openMenu();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      open ? moveActive(-1) : openMenu();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    } else if (!open && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const idx = options.findIndex((o) => {
        const label = typeof o.label === "string" ? o.label : o.value;
        return label.toLowerCase().startsWith(e.key.toLowerCase());
      });
      const opt = options[idx];
      if (idx >= 0 && opt && !opt.disabled) onChange(opt.value);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === "Enter" || (e.key === " " && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) pick(opt);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onListKeyDown}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listId.current : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onButtonKeyDown}
        className={`inline-flex h-8 w-full items-center justify-between gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-xs text-[var(--fg)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]/60 disabled:opacity-45 disabled:hover:bg-[var(--bg)] ${buttonClassName}`}
      >
        <span className={`truncate ${selected ? "" : "text-[var(--fg-subtle)]"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-[var(--fg-subtle)] transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          id={listId.current}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeIndex >= 0 ? `${listId.current}-opt-${activeIndex}` : undefined}
          className="absolute left-0 top-full z-50 mt-1.5 w-full min-w-[11rem] overflow-hidden rounded-[9px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-popover)]"
        >
          {searchable && (
            <div className="border-b p-1.5">
              <div className="relative">
                <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIndex(0);
                  }}
                  placeholder={searchPlaceholder}
                  className="h-7 w-full rounded-[6px] border border-transparent bg-[var(--bg)] pl-7 pr-2 text-xs outline-none placeholder:text-[var(--fg-subtle)] focus:border-[var(--border-strong)]"
                />
              </div>
            </div>
          )}
          <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-xs text-[var(--fg-subtle)]">{emptyLabel}</div>
            ) : (
              filtered.map((o, i) => {
                const isSelected = o.value === value;
                const isActive = i === activeIndex;
                return (
                  <div
                    key={o.value}
                    id={`${listId.current}-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={o.disabled || undefined}
                    onPointerEnter={() => setActiveIndex(i)}
                    onClick={() => pick(o)}
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-xs transition-colors ${
                      o.disabled ? "cursor-not-allowed opacity-45" : ""
                    } ${
                      isActive
                        ? "bg-[var(--bg-subtle)] text-[var(--fg)]"
                        : isSelected
                          ? "text-[var(--fg)]"
                          : "text-[var(--fg-muted)]"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{o.label}</span>
                      {o.hint && (
                        <span className="block truncate text-[10px] text-[var(--fg-subtle)]">{o.hint}</span>
                      )}
                    </span>
                    {isSelected && <Check className="size-3.5 shrink-0 text-[var(--accent)]" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
