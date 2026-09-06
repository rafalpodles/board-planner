"use client";

import { useId } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  dirty?: boolean;
  labelHidden?: boolean;
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  dirty,
  labelHidden,
}: SwitchProps) {
  const hintId = useId();

  return (
    <label
      className={`flex cursor-pointer items-start gap-3 ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        aria-label={labelHidden ? label : undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors
          peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
          peer-focus-visible:outline-primary
          after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full
          after:transition-transform
          ${checked ? "bg-primary-solid after:translate-x-4 after:bg-white" : "bg-bg-input after:bg-text-muted"}`}
      />
      {!labelHidden && (
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-text">
            {label}
            {dirty && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-warning"
                title="Unsaved"
              />
            )}
          </span>
          {hint && (
            <span id={hintId} className="mt-0.5 block text-xs text-text-muted">
              {hint}
            </span>
          )}
        </span>
      )}
    </label>
  );
}
