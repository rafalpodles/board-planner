"use client";

import type { CSSProperties } from "react";
import { Combobox } from "@/components/ui/Combobox";

interface Column {
  id: string;
  label: string;
  color: string;
}

interface StatusPillProps {
  columns: Column[];
  status: string;
  onChange: (status: string) => void;
}

export function StatusPill({ columns, status, onChange }: StatusPillProps) {
  const current = columns.find((c) => c.id === status);
  const accent = current?.color || "var(--color-primary)";

  return (
    <Combobox
      label="Status"
      value={status}
      options={columns.map((column) => ({
        value: column.id,
        label: column.label,
        color: column.color,
      }))}
      onChange={(next) => {
        if (next !== status) onChange(next);
      }}
      triggerClassName="rounded-lg"
    >
      {() => (
        // The tint lives here rather than on the trigger: `.chip` resolves `--chip` on
        // its own element, and Combobox owns the trigger's class list
        <span
          className="chip flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
          style={{ "--chip": accent } as CSSProperties}
        >
          <span
            aria-hidden
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: accent }}
          />
          {current?.label || status}
          <span aria-hidden className="text-[10px] opacity-60">
            ▾
          </span>
        </span>
      )}
    </Combobox>
  );
}
