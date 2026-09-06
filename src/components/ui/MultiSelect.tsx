"use client";

import type { CSSProperties } from "react";
import { Combobox, ComboboxOption } from "./Combobox";

interface MultiSelectProps {
  label?: string;
  ariaLabel?: string;
  value: string[];
  options: ComboboxOption[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}

export function MultiSelect({
  label,
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = "Select...",
  required,
  disabled,
}: MultiSelectProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="mb-1 block text-sm font-medium text-text-muted">
          {label}
          {required && <span className="text-danger">*</span>}
        </label>
      )}
      <Combobox
        multiple
        value={value}
        options={options}
        onChange={onChange}
        label={ariaLabel || label || placeholder}
        emptyOption="Clear all"
        disabled={disabled}
        triggerClassName="min-h-[44px] w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-left text-text disabled:pointer-events-none disabled:opacity-50"
      >
        {(selected) =>
          selected.length === 0 ? (
            <span className="text-sm text-text-muted">{placeholder}</span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {selected.map((option) => (
                <span
                  key={option.value}
                  className="chip chip-custom rounded px-2 py-0.5 text-xs"
                  style={{ "--chip": option.color } as CSSProperties}
                >
                  {option.label}
                </span>
              ))}
            </span>
          )
        }
      </Combobox>
    </div>
  );
}
