"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_HIDDEN,
  HIDEABLE_COLUMNS,
  LIST_COLUMNS,
  ListColumnId,
  toggleColumn,
  visibleCount,
} from "@/lib/list-columns";

interface ColumnPickerProps {
  hidden: ListColumnId[];
  onChange: (hidden: ListColumnId[]) => void;
}

export function ColumnPicker({ hidden, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = visibleCount(hidden);
  const isDefault = hidden.length === DEFAULT_HIDDEN.length;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Choose columns"
        className={`focus-ring flex h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
          isDefault
            ? "border-border text-text-muted hover:text-text"
            : "border-primary bg-primary/10 text-primary"
        }`}
      >
        Columns
        {!isDefault && (
          <span className="text-[11px]">
            {shown}/{LIST_COLUMNS.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="group"
          aria-label="Columns"
          className="absolute right-0 top-full z-40 mt-1 w-56 rounded-xl border border-border bg-bg-card p-2 shadow-lg"
        >
          {HIDEABLE_COLUMNS.map((column) => {
            const checked = !hidden.includes(column.id);
            return (
              <label
                key={column.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-hover"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(toggleColumn(hidden, column.id))}
                  className="focus-ring rounded border-border"
                />
                {column.label}
              </label>
            );
          })}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => onChange(DEFAULT_HIDDEN)}
              disabled={isDefault}
              className="focus-ring w-full rounded-md px-2 py-1.5 text-left text-[12px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
