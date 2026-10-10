"use client";

import { useId, type CSSProperties } from "react";
import { ApiCustomField } from "@/types";
import { FieldFilter, orderedOptions, pickedOptions } from "@/lib/custom-fields";

interface OptionFilterProps {
  field: ApiCustomField;
  filter: FieldFilter;
  onChange: (patch: FieldFilter) => void;
}

export function OptionFilter({ field, filter, onChange }: OptionFilterProps) {
  const labelId = useId();
  const picked = pickedOptions(filter);
  const mode = filter.mode === "all" ? "all" : "any";

  function toggle(id: string) {
    const values = picked.includes(id) ? picked.filter((v) => v !== id) : [...picked, id];
    onChange({ value: "", values, mode });
  }

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[11px] text-text-muted">
        {field.name}
      </span>
      <div className="scroll-ring-room flex max-h-28 flex-wrap gap-1 overflow-y-auto">
        {orderedOptions(field).map((option) => {
          const on = picked.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(option.id)}
              style={{ "--chip": option.color } as CSSProperties}
              className={`focus-ring chip chip-custom max-w-full truncate rounded-full px-2 py-0.5 text-[12px] ${
                on ? "ring-2 ring-primary font-semibold" : "opacity-80 hover:opacity-100"
              }`}
            >
              {on && <span aria-hidden>✓ </span>}
              {option.value}
            </button>
          );
        })}
      </div>
      {picked.length > 1 && (
        <div role="group" aria-label={`${field.name} match`} className="flex w-fit overflow-hidden rounded-lg border border-border text-[12px]">
          {(["any", "all"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={mode === choice}
              onClick={() => onChange({ mode: choice })}
              className={`focus-ring-inset px-2 py-1 ${
                mode === choice ? "bg-primary/15 text-primary-on-tint" : "text-text-muted hover:text-text"
              }`}
            >
              {choice === "any" ? "Any of them" : "All of them"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
