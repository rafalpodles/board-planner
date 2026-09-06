"use client";

import { useState } from "react";
import { GrowingTextarea, ProgressBar, SectionLabel } from "./atoms";
import type { ChecklistDraftItem } from "./useTaskEditor";
import type { Trigger } from "@/hooks/use-trigger-autocomplete";
import { AutocompleteTextarea } from "@/components/ui/AutocompleteTextarea";
import type { ReferenceScope } from "@/lib/task-references";
import { MarkdownContent } from "@/components/ui/MarkdownContent";

interface CriteriaSectionProps {
  items: ChecklistDraftItem[];
  onChange: (items: ChecklistDraftItem[]) => void;
  triggers?: Trigger[];
  scope?: ReferenceScope | null;
}

const EMPTY: Trigger[] = [];

export function CriteriaSection({ items, onChange, triggers, scope }: CriteriaSectionProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const done = items.filter((i) => i.done).length;

  function add() {
    if (!draft.trim()) return;
    onChange([...items, { text: draft.trim(), done: false }]);
    setDraft("");
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <SectionLabel>Acceptance criteria</SectionLabel>
        {items.length > 0 && (
          <>
            <ProgressBar done={done} total={items.length} />
            <span className="font-mono text-xs font-semibold text-text-muted">
              {done}/{items.length}
            </span>
          </>
        )}
      </div>

      <div className="flex flex-col">
        {items.map((item, i) => (
          <div
            key={item._id || `new-${i}`}
            className="group -mx-2.5 flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-bg-hover"
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={item.done}
              aria-label={item.text}
              onClick={() =>
                onChange(items.map((it, idx) => (idx === i ? { ...it, done: !it.done } : it)))
              }
              className={`focus-ring mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-[1.5px]
                text-[11px] font-extrabold transition-colors ${
                  item.done
                    ? "border-success bg-success text-bg"
                    : "border-border hover:border-text-muted"
                }`}
            >
              {item.done ? "✓" : ""}
            </button>
            {editing === i ? (
              <AutocompleteTextarea
                value={item.text}
                triggers={triggers ?? EMPTY}
                autoFocus
                aria-label={`Criterion ${i + 1}`}
                onChange={(text) =>
                  onChange(items.map((it, idx) => (idx === i ? { ...it, text } : it)))
                }
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
                className={`focus-ring min-w-0 flex-1 rounded bg-transparent text-sm leading-snug ${
                  item.done ? "text-text-muted line-through" : "text-text"
                }`}
              />
            ) : (
              <div
                role="button"
                tabIndex={0}
                aria-label={`Criterion ${i + 1}`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  setEditing(i);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditing(i);
                  }
                }}
                className={`focus-ring min-w-0 flex-1 cursor-text whitespace-pre-wrap rounded text-sm leading-snug ${
                  item.done ? "text-text-muted line-through" : "text-text"
                }`}
              >
                <MarkdownContent inline scope={scope}>
                  {item.text}
                </MarkdownContent>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove criterion ${i + 1}`}
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="focus-ring shrink-0 rounded px-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
            >
              &times;
            </button>
          </div>
        ))}

        <div className="-mx-2.5 flex items-center gap-3 rounded-lg px-2.5 py-2">
          <span aria-hidden className="w-4 text-center text-text-muted">
            +
          </span>
          <AutocompleteTextarea
            value={draft}
            triggers={triggers ?? EMPTY}
            onChange={setDraft}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
            aria-label="Add criterion"
            placeholder="Add criterion"
            className="focus-ring min-w-0 flex-1 rounded bg-transparent text-sm leading-snug text-text placeholder:text-text-muted"
          />
        </div>
      </div>
    </section>
  );
}
