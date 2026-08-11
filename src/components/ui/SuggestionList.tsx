"use client";

import type { Suggestion } from "@/hooks/use-trigger-autocomplete";
import type { CaretPoint } from "@/lib/caret";

/**
 * The list an autocomplete trigger drops above the caret. Extracted from Comments along with the
 * logic, so the composer and the description editor cannot drift apart in how they look or in
 * which key does what.
 */
export function SuggestionList({
  items,
  index,
  onPick,
  onHover,
  at,
}: {
  items: Suggestion[];
  index: number;
  onPick: (suggestion: Suggestion) => void;
  onHover?: (index: number) => void;
  /** Where the caret is inside the field. Without it the list sits above the whole box, which is
      fine on a two-line composer and useless on a 400px description. */
  at?: CaretPoint | null;
}) {
  if (items.length === 0) return null;

  return (
    <div
      role="listbox"
      style={at ? { top: at.top + at.lineHeight, left: at.left } : undefined}
      className={`absolute z-20 max-h-[160px] min-w-[200px] overflow-y-auto rounded-lg border border-border bg-bg-card py-1 shadow-lg ${
        at ? "" : "bottom-full left-0 mb-1"
      }`}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover ${
            i === index ? "bg-bg-hover" : ""
          }`}
          onMouseEnter={() => onHover?.(i)}
          // mousedown, not click: the textarea blurs first and the list would be gone by then
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="font-medium">{item.label}</span>
          {item.hint && <span className="truncate text-xs text-text-muted">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
