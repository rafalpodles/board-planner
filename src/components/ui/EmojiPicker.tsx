"use client";

interface EmojiPickerProps {
  label?: string;
  value: string;
  options: string[];
  fallback: string;
  onChange: (value: string) => void;
}

export function EmojiPicker({ label, value, options, fallback, onChange }: EmojiPickerProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-text-muted mb-1">
          {label}
        </label>
      )}
      <div className="rounded-lg border border-border bg-bg-input p-3">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            {value || fallback}
          </span>
          <span className="text-sm text-text-muted">
            {value ? "Selected" : "Default"}
          </span>
          {value && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="ml-auto text-sm text-text-muted hover:text-text cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {options.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Select icon ${emoji}`}
              aria-pressed={value === emoji}
              onClick={() => onChange(emoji)}
              className={`w-9 h-9 flex items-center justify-center rounded-lg text-lg cursor-pointer transition-colors ${
                value === emoji
                  ? "bg-primary/20 ring-2 ring-primary"
                  : "hover:bg-bg-hover"
              }`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
