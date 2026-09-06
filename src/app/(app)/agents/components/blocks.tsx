"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AgentBucket, ApiAgentBlock } from "@/types";
import { Popover } from "@/components/ui/Popover";
import { BUCKETS } from "../catalog";

export const NEW_PREFIX = "new:";
export const BUCKET_PREFIX = "bucket:";

export interface Entry {
  uid: string;
  key: string;
  params?: Record<string, string>;
}

export type Lookup = (key: string) => ApiAgentBlock | undefined;

function KindDot({ kind }: { kind: ApiAgentBlock["kind"] }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        kind === "step" ? "bg-primary" : "bg-text-muted"
      }`}
    />
  );
}

export function BlockBody({ block }: { block: ApiAgentBlock }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <KindDot kind={block.kind} />
        <span className="truncate text-[13px] font-medium">{block.name}</span>
      </div>
      <p className="mt-0.5 truncate text-[12px] text-text-muted">{block.description}</p>
    </div>
  );
}

export function PaletteItem({
  block,
  onAdd,
}: {
  block: ApiAgentBlock;
  onAdd: (bucket: AgentBucket, key: string) => void;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${NEW_PREFIX}${block.key}`,
  });

  return (
    <li
      ref={setNodeRef}
      className={`flex items-center gap-2 rounded-lg border border-border bg-bg-card px-3 py-2 transition-colors hover:border-border-strong ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <span {...attributes} {...listeners} className="min-w-0 flex-1 cursor-grab">
        <BlockBody block={block} />
      </span>
      <Popover
        align="right"
        width="w-44"
        label={`Where to add ${block.name}`}
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label={`Add ${block.name} to a phase`}
            className="focus-ring shrink-0 rounded-md border border-border px-2 py-1 text-[12px] leading-none text-text-muted hover:border-border-strong hover:text-text"
          >
            Add
          </button>
        )}
      >
        {({ close }) => (
          <ul className="flex flex-col">
            {BUCKETS.map((bucket) => (
              <li key={bucket.id}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(bucket.id, block.key);
                    close();
                  }}
                  className="focus-ring w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-bg-hover"
                >
                  {bucket.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </li>
  );
}

export function Palette({
  steps,
  gates,
  onAdd,
}: {
  steps: ApiAgentBlock[];
  gates: ApiAgentBlock[];
  onAdd: (bucket: AgentBucket, key: string) => void;
}) {
  return (
    <aside className="lg:sticky lg:top-4 lg:self-start">
      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Steps</h2>
      <p className="mb-2 mt-1 text-[12px] text-text-muted">Work. Each one is a fresh session.</p>
      <ul className="mb-5 flex flex-col gap-2">
        {steps.map((block) => (
          <PaletteItem key={block.key} block={block} onAdd={onAdd} />
        ))}
      </ul>

      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Gates</h2>
      <p className="mb-2 mt-1 text-[12px] text-text-muted">Checks. They only say yes or no.</p>
      <ul className="flex flex-col gap-2">
        {gates.map((block) => (
          <PaletteItem key={block.key} block={block} onAdd={onAdd} />
        ))}
      </ul>
    </aside>
  );
}

function SortableEntry({
  entry,
  onRemove,
  lookup,
  readOnly = false,
}: {
  entry: Entry;
  onRemove: () => void;
  lookup: Lookup;
  readOnly?: boolean;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: entry.uid,
  });
  const block = lookup(entry.key);
  if (!block) return null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border border-border bg-bg-card px-3 py-2 ${
        isDragging ? "relative z-10 opacity-85" : ""
      }`}
    >
      {readOnly ? (
        <span className="min-w-0 flex-1">
          <BlockBody block={block} />
        </span>
      ) : (
        <>
          <span {...attributes} {...listeners} className="min-w-0 flex-1 cursor-grab">
            <BlockBody block={block} />
          </span>
          <button
            onClick={onRemove}
            aria-label={`Remove ${block.name}`}
            className="focus-ring shrink-0 rounded p-1 text-text-muted transition-colors hover:text-danger"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
    </li>
  );
}

export function Bucket({
  id,
  label,
  hint,
  entries,
  onRemove,
  lookup,
  readOnly = false,
}: {
  id: AgentBucket;
  label: string;
  hint: string;
  entries: Entry[];
  onRemove: (uid: string) => void;
  lookup: Lookup;
  readOnly?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${BUCKET_PREFIX}${id}` });

  return (
    <section className="mb-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">{label}</h2>
        <span className="text-[12px] text-text-muted">{hint}</span>
      </div>

      <ul
        ref={setNodeRef}
        data-testid={`bucket-${id}`}
        className={`flex min-h-[72px] flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors ${
          isOver ? "border-primary bg-primary/5" : "border-border"
        }`}
      >
        <SortableContext items={entries.map((e) => e.uid)} strategy={verticalListSortingStrategy}>
          {entries.map((entry) => (
            <SortableEntry
              key={entry.uid}
              entry={entry}
              lookup={lookup}
              readOnly={readOnly}
              onRemove={() => onRemove(entry.uid)}
            />
          ))}
        </SortableContext>

        {entries.length === 0 && (
          <p className="py-3 text-center text-[12px] text-text-muted">
            {readOnly ? "Nothing here." : "Drag a step or a gate here."}
          </p>
        )}
      </ul>
    </section>
  );
}
