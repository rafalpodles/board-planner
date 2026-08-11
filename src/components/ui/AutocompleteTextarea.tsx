"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTriggerAutocomplete, type Trigger } from "@/hooks/use-trigger-autocomplete";
import { SuggestionList } from "@/components/ui/SuggestionList";
import { GrowingTextarea } from "@/components/tasks/detail/atoms";

/**
 * A growing textarea that offers `@` and task references.
 *
 * A component rather than a hook each caller wires up, because acceptance criteria are a list: one
 * field per item, and a hook cannot be called in a loop. Each item being its own component is what
 * makes that legal — and it stopped the three composers that already existed from wiring the same
 * thing three slightly different ways.
 */
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
  /** For a field that appears because somebody asked to edit — the caret goes where they clicked */
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
    // At the end, so clicking a criterion to change it does not drop the caret at character zero
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [autoFocus]);

  return (
    // The wrapper stands where the field used to, so it has to carry the field's sizing: callers
    // put `flex-1 min-w-0` on the textarea because it was a direct child of a flex row, and once
    // this div came between them that class did nothing — the acceptance criteria collapsed to a
    // column a few characters wide. The field fills the wrapper instead.
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
          // The list first: while it is open the arrows and Enter belong to it, so picking a
          // suggestion is never also a send
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
