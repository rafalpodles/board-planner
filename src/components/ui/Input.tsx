"use client";

import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-text-muted mb-1">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full rounded-lg border bg-bg-input px-3 py-2 text-text min-h-[44px]
            placeholder:text-text-muted/50
            focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent
            ${error ? "border-danger" : "border-border"}
            ${className}`}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
