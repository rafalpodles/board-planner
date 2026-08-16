"use client";

import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  dirty?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, dirty, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="flex items-center gap-2 text-sm font-medium text-text-muted mb-1">
            {label}
            {dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unsaved" />}
          </label>
        )}
        <select
          ref={ref}
          className={`focus-ring w-full rounded-lg border bg-bg-input px-3 py-2 text-text min-h-[44px]
            disabled:opacity-50 disabled:pointer-events-none
            ${error ? "border-danger" : dirty ? "border-warning/60" : "border-border"}
            ${className}`}
          {...props}
        >
          {placeholder && (
            <option value="" className="text-text-muted">
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  }
);

Select.displayName = "Select";
