"use client";

import type { CSSProperties } from "react";
import { Popover } from "@/components/ui/Popover";
import { OptionItem, OptionList } from "./FieldRow";

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
    <Popover
      label="Status"
      width="w-52"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="focus-ring chip flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
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
        </button>
      )}
    >
      {({ close }) => (
        <OptionList label="Status">
          {columns.map((column) => (
            <OptionItem
              key={column.id}
              selected={column.id === status}
              onClick={() => {
                if (column.id !== status) onChange(column.id);
                close();
              }}
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: column.color }}
              />
              {column.label}
            </OptionItem>
          ))}
        </OptionList>
      )}
    </Popover>
  );
}
