"use client";

import { TextareaHTMLAttributes, forwardRef } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-text-muted mb-1">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          className={`w-full rounded-lg border bg-bg-input px-3 py-2 text-text min-h-[88px]
            placeholder:text-text-muted/50
            focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-y
            ${error ? "border-danger" : "border-border"}
            ${className}`}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
