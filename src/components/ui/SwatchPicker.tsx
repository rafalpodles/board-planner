"use client";

import { PALETTE, colourName } from "@/lib/palette";

interface SwatchPickerProps {
  value: string;
  onChange: (hex: string) => void;
  label: string;
  disabled?: boolean;
}

export function SwatchPicker({ value, onChange, label, disabled }: SwatchPickerProps) {
  const selected = value?.toLowerCase();

  return (
    <div>
      <div
        role="group"
        aria-label={label}
        className="grid w-max grid-cols-[repeat(10,1.75rem)] gap-1.5"
      >
        {PALETTE.map((colour) => {
          const active = colour.hex.toLowerCase() === selected;
          return (
            <button
              key={colour.hex}
              type="button"
              disabled={disabled}
              aria-label={colour.name}
              aria-pressed={active}
              onClick={() => onChange(colour.hex)}
              style={{ backgroundColor: colour.hex }}
              className={`focus-ring relative h-7 w-7 rounded-md border-2 transition-transform
                disabled:cursor-not-allowed disabled:opacity-50
                ${active ? "border-text" : "border-transparent hover:scale-110"}`}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-0 grid place-items-center text-[10px] text-white drop-shadow"
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-text-muted">{colourName(value) || "No colour"}</p>
    </div>
  );
}
