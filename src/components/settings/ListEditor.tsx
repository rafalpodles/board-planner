"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { moveItem } from "@/lib/reorder";

interface ListEditorProps<T> {
  items: T[];
  onChange: (next: T[]) => void;
  keyOf: (item: T, index: number) => string;
  /** The row's own controls. Whatever a row contains is the caller's business. */
  renderRow: (item: T, index: number) => React.ReactNode;
  /** Names the row in the reorder and remove labels a screen reader announces */
  nameOf: (item: T) => string;
  onAdd?: () => void;
  addLabel?: string;
  canRemove?: (item: T) => boolean;
  reorderable?: boolean;
  empty?: React.ReactNode;
}

/**
 * Add, reorder, edit, remove — for columns, categories, field options and templates,
 * which each grew their own version of this.
 *
 * Removal is `onChange` on the array, not a request: a row is a field, so it collects in
 * the save bar like every other field. Destroying a whole object is DangerAction's job.
 */
export function ListEditor<T>({
  items,
  onChange,
  keyOf,
  renderRow,
  nameOf,
  onAdd,
  addLabel = "Add",
  canRemove,
  reorderable = true,
  empty,
}: ListEditorProps<T>) {
  const dragIndex = useRef<number | null>(null);

  function move(from: number, to: number) {
    const next = moveItem(items, from, to);
    if (next !== items) onChange(next);
  }

  if (items.length === 0 && empty) {
    return (
      <div className="space-y-2">
        {empty}
        {onAdd && (
          <Button variant="secondary" size="sm" onClick={onAdd}>
            + {addLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {items.map((item, i) => {
        const name = nameOf(item);
        const removable = canRemove ? canRemove(item) : true;

        return (
          <div
            key={keyOf(item, i)}
            draggable={reorderable}
            onDragStart={() => {
              dragIndex.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex.current !== null) {
                move(dragIndex.current, i);
                dragIndex.current = null;
              }
            }}
            className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0"
          >
            {reorderable && (
              <span aria-hidden className="cursor-grab select-none text-text-muted">
                ⠿
              </span>
            )}

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
              {renderRow(item, i)}
            </div>

            <div className="flex items-center gap-1">
              {reorderable && (
                <>
                  {/* The grip is pointer-only, so the same move has to be reachable by key */}
                  <button
                    type="button"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label={`Move ${name} up`}
                    className="focus-ring inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-text disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, i + 1)}
                    disabled={i === items.length - 1}
                    aria-label={`Move ${name} down`}
                    className="focus-ring inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-text disabled:opacity-30"
                  >
                    ↓
                  </button>
                </>
              )}
              {removable && (
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                  aria-label={`Remove ${name}`}
                  className="focus-ring inline-flex h-11 w-11 items-center justify-center rounded text-text-muted sm:h-6 sm:w-auto sm:px-1 hover:text-danger"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}

      {onAdd && (
        <div className="bg-bg-input/40 px-3 py-2.5">
          <Button variant="secondary" size="sm" onClick={onAdd}>
            + {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
