"use client";

import { TextareaHTMLAttributes, forwardRef, useRef, useState, useCallback, ClipboardEvent, DragEvent } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  onFileUpload?: (file: File) => Promise<string>;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = "", onFileUpload, onChange, ...props }, ref) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    const setRefs = useCallback(
      (el: HTMLTextAreaElement | null) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      },
      [ref]
    );

    const insertAtCursor = useCallback(
      (text: string) => {
        const textarea = innerRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        const newValue = before + text + after;

        // Trigger React onChange
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        nativeInputValueSetter?.call(textarea, newValue);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));

        // Set cursor after inserted text
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + text.length;
          textarea.focus();
        });
      },
      []
    );

    const handleFile = useCallback(
      async (file: File) => {
        if (!onFileUpload) return;
        setUploading(true);
        try {
          const markdown = await onFileUpload(file);
          insertAtCursor(markdown + "\n");
        } catch (err) {
          console.error("Upload failed:", err);
        } finally {
          setUploading(false);
        }
      },
      [onFileUpload, insertAtCursor]
    );

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLTextAreaElement>) => {
        if (!onFileUpload) return;
        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of Array.from(items)) {
          if (item.kind === "file") {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) handleFile(file);
            return;
          }
        }
      },
      [onFileUpload, handleFile]
    );

    const handleDrop = useCallback(
      (e: DragEvent<HTMLTextAreaElement>) => {
        if (!onFileUpload) return;
        const files = e.dataTransfer?.files;
        if (!files?.length) return;

        e.preventDefault();
        handleFile(files[0]);
      },
      [onFileUpload, handleFile]
    );

    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-text-muted mb-1">
            {label}
          </label>
        )}
        <div className="relative">
          <textarea
            ref={setRefs}
            className={`w-full rounded-lg border bg-bg-input px-3 py-2 text-text min-h-[88px]
              placeholder:text-text-muted/50
              focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-y
              ${error ? "border-danger" : "border-border"}
              ${className}`}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onChange={onChange}
            {...props}
          />
          {onFileUpload && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="absolute bottom-2 right-2 text-text-muted hover:text-text p-1 rounded transition-colors"
                title="Attach file (or paste/drop)"
              >
                {uploading ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
