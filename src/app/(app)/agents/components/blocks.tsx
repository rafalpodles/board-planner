"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AgentBucket, ApiAgentBlock } from "@/types";

export const NEW_PREFIX = "new:";
export const BUCKET_PREFIX = "bucket:";

export interface Entry {
  uid: string;
  key: string;
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

export function PaletteItem({ block }: { block: ApiAgentBlock }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${NEW_PREFIX}${block.key}`,
  });

  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`cursor-grab rounded-lg border border-border bg-bg-card px-3 py-2 transition-colors hover:border-border-strong ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <BlockBody block={block} />
    </li>
  );
}

export function Palette({ steps, gates }: { steps: ApiAgentBlock[]; gates: ApiAgentBlock[] }) {
  return (
    <aside className="lg:sticky lg:top-4 lg:self-start">
      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Steps</h2>
      <p className="mb-2 mt-1 text-[12px] text-text-muted">Work. Each one is a fresh session.</p>
      <ul className="mb-5 flex flex-col gap-2">
        {steps.map((block) => (
          <PaletteItem key={block.key} block={block} />
        ))}
      </ul>

      <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Gates</h2>
      <p className="mb-2 mt-1 text-[12px] text-text-muted">Checks. They only say yes or no.</p>
      <ul className="flex flex-col gap-2">
        {gates.map((block) => (
          <PaletteItem key={block.key} block={block} />
        ))}
      </ul>
    </aside>
  );
}

function SortableEntry({
  entry,
  onRemove,
  lookup,
}: {
  entry: Entry;
  onRemove: () => void;
  lookup: Lookup;
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
}: {
  id: AgentBucket;
  label: string;
  hint: string;
  entries: Entry[];
  onRemove: (uid: string) => void;
  lookup: Lookup;
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
              onRemove={() => onRemove(entry.uid)}
            />
          ))}
        </SortableContext>

        {entries.length === 0 && (
          <p className="py-3 text-center text-[12px] text-text-muted">Drag a step or a gate here.</p>
        )}
      </ul>
    </section>
  );
}
