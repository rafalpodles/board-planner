"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_PROJECT_ICON } from "@/types";
import { searchIcons } from "@/lib/project-icons";

interface IconPickerProps {
  value: string;
  onChange: (icon: string) => void;
  label: string;
  dirty?: boolean;
}

/**
 * A popover instead of forty always-open buttons. The old picker put every icon inline
 * in the card — forty tab stops announced as forty independent toggles, and the field
 * below it pushed off the screen.
 */
export function IconPicker({ value, onChange, label, dirty }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    function onPointerDown(e: MouseEvent) {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const groups = searchIcons(query);

  return (
    <div ref={anchor} className="relative">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-bg-input text-2xl"
        >
          {value || DEFAULT_PROJECT_ICON}
        </button>
        <div className="text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            Shown in the sidebar, search and the board header
            {dirty && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-warning"
                title="Unsaved"
              />
            )}
          </span>
        </div>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute z-30 mt-2 w-[320px] rounded-xl border border-border bg-bg-card p-3 shadow-lg"
        >
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search icons…"
            aria-label="Search icons"
            className="focus-ring-inset w-full rounded-lg bg-bg-input px-2.5 py-2 text-sm text-text placeholder:text-text-muted"
          />
          <div className="mt-2 max-h-56 overflow-y-auto">
            {groups.length === 0 && (
              <p className="px-1 py-3 text-xs text-text-muted">No icons match “{query}”.</p>
            )}
            {groups.map((group) => (
              <div key={group.name}>
                <p className="px-1 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                  {group.name}
                </p>
                <div className="grid grid-cols-8 gap-1">
                  {group.icons.map(({ icon }) => (
                    <button
                      key={icon}
                      type="button"
                      aria-label={icon}
                      aria-pressed={icon === value}
                      onClick={() => {
                        onChange(icon);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`focus-ring grid aspect-square place-items-center rounded-md text-lg
                        hover:bg-bg-hover ${icon === value ? "bg-primary/20" : ""}`}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
