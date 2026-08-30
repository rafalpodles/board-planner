"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiCustomField } from "@/types";
import {
  defaultHidden,
  hideableColumns,
  listColumns,
  ListColumnId,
  toggleColumn,
  visibleCount,
} from "@/lib/list-columns";

interface ColumnPickerProps {
  hidden: ListColumnId[];
  onChange: (hidden: ListColumnId[]) => void;
  customFields?: ApiCustomField[];
}

export function ColumnPicker({ hidden, onChange, customFields = [] }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

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

  /**
   * The panel is anchored to the button's right edge, and the button is the last item in a
   * wrapping toolbar — so where it sits depends on whether the row wrapped, which depends on the
   * width, the sort control's current label and whether the board is read-only. Measured with a
   * fixed anchor: `right-0` opens 128px past the left edge of a 375px phone, where the row wraps
   * and the button lands at x=20; `left-0` opens 73-113px past the right edge at 390-480, where it
   * does not. No static anchor is right at both, so the panel is measured and pulled back in —
   * Combobox does the same thing for the same reason.
   */
  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const box = panelRef.current?.getBoundingClientRect();
    if (!box) return;
    const gutter = 12;
    const past = box.right - (window.innerWidth - gutter);
    const short = gutter - box.left;
    setShiftX(short > 0 ? short : past > 0 ? -past : 0);
  }, [open]);

  const shown = visibleCount(hidden, customFields);
  const columns = hideableColumns(customFields);
  const builtIn = columns.filter((c) => !c.field);
  const fromProject = columns.filter((c) => c.field);
  const fallback = defaultHidden(customFields);
  // Compared as sets: lengths alone called any three hidden columns "default"
  const isDefault =
    hidden.length === fallback.length && fallback.every((id) => hidden.includes(id));

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Choose columns"
        className={`focus-ring flex h-11 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
          isDefault
            ? "border-border text-text-muted hover:text-text"
            : "border-primary bg-primary/10 text-primary"
        }`}
      >
        Columns
        {!isDefault && (
          <span className="text-[11px]">
            {shown}/{listColumns(customFields).length}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="group"
          aria-label="Columns"
          style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
          className="absolute right-0 top-full z-40 mt-1 w-56 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-bg-card p-2 shadow-lg"
        >
          {builtIn.map((column) => (
            <label
              key={column.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-hover"
            >
              <input
                type="checkbox"
                checked={!hidden.includes(column.id)}
                onChange={() => onChange(toggleColumn(hidden, column.id))}
                className="focus-ring rounded border-border"
              />
              {column.label}
            </label>
          ))}

          {/* Kept apart, so it is obvious which columns this project invented */}
          {fromProject.length > 0 && (
            <>
              <p className="mt-2 px-2 pb-1 pt-1 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                Project fields
              </p>
              {fromProject.map((column) => (
                <label
                  key={column.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={!hidden.includes(column.id)}
                    onChange={() => onChange(toggleColumn(hidden, column.id))}
                    className="focus-ring rounded border-border"
                  />
                  {column.label}
                </label>
              ))}
            </>
          )}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => onChange(fallback)}
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
