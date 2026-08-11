"use client";

import { useRef, type KeyboardEvent } from "react";
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
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  triggers: Trigger[];
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const autocomplete = useTriggerAutocomplete(triggers, ref, onChange);

  return (
    <div className="relative flex-1">
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
        className={className}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
