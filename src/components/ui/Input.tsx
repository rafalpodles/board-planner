"use client";

import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  dirty?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, dirty, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="flex items-center gap-2 text-sm font-medium text-text-muted mb-1">
            {label}
            {dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unsaved" />}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full rounded-lg border bg-bg-input px-3 py-2 text-text min-h-[44px]
            placeholder:text-text-muted
            focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent
            ${error ? "border-danger" : dirty ? "border-warning/60" : "border-border"}
            ${className}`}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
