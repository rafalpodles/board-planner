"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTriggerAutocomplete, type Trigger } from "@/hooks/use-trigger-autocomplete";
import { SuggestionList } from "@/components/ui/SuggestionList";
import { GrowingTextarea } from "@/components/tasks/detail/atoms";

export function AutocompleteTextarea({
  value,
  onChange,
  triggers,
  onKeyDown,
  onBlur,
  className,
  placeholder,
  autoFocus = false,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  triggers: Trigger[];
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const autocomplete = useTriggerAutocomplete(triggers, ref, onChange);

  useEffect(() => {
    if (!autoFocus) return;
    const textarea = ref.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [autoFocus]);

  return (
    <div className="relative min-w-0 flex-1">
      <SuggestionList
        items={autocomplete.items}
        index={autocomplete.index}
        at={autocomplete.at}
        onPick={autocomplete.choose}
        onHover={autocomplete.setIndex}
      />
      <GrowingTextarea
        textareaRef={ref}
        value={value}
        onChange={(next) => {
          onChange(next);
          autocomplete.detect(next, ref.current?.selectionStart ?? next.length);
        }}
        onKeyDown={(e) => {
          autocomplete.onKeyDown(e);
          if (e.defaultPrevented) return;
          onKeyDown?.(e);
        }}
        onBlur={() => {
          setTimeout(autocomplete.close, 150);
          onBlur?.();
        }}
        className={`w-full ${className ?? ""}`}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
