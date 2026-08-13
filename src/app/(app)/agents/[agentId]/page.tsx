"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  CollisionDetection,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { BUCKETS, BucketId, Block, emptyComposition } from "../catalog";
import { useStore } from "../store";

interface Entry {
  uid: string;
  key: string;
}

type Entries = Record<BucketId, Entry[]>;

const NEW_PREFIX = "new:";
const BUCKET_PREFIX = "bucket:";

let counter = 0;
const nextUid = () => `e${++counter}`;

// Corner distance picks a neighbouring bucket's first row over the bucket the cursor is actually
// inside; the pointer is the only honest signal here. rectIntersection is the keyboard fallback,
// where there is no pointer at all.
const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  return byPointer.length > 0 ? byPointer : rectIntersection(args);
};

function KindDot({ kind }: { kind: Block["kind"] }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        kind === "step" ? "bg-primary" : "bg-text-muted"
      }`}
    />
  );
}

function BlockBody({ block, muted }: { block: Block; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <KindDot kind={block.kind} />
        <span className={`truncate text-[13px] font-medium ${muted ? "text-text-muted" : ""}`}>
          {block.name}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[12px] text-text-muted">{block.description}</p>
    </div>
  );
}

function PaletteItem({ block }: { block: Block }) {
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

function SortableEntry({
  entry,
  onRemove,
  lookup,
}: {
  entry: Entry;
  onRemove: () => void;
  lookup: (key: string) => Block | undefined;
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

function Bucket({
  id,
  label,
  hint,
  entries,
  onRemove,
  lookup,
}: {
  id: BucketId;
  label: string;
  hint: string;
  entries: Entry[];
  onRemove: (uid: string) => void;
  lookup: (key: string) => Block | undefined;
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

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const store = useStore();
  const agent = store.allAgents.find((a) => a.id === params.agentId);
  const lookup = (key: string) =>
    [...store.allSteps, ...store.allGates].find((b) => b.key === key);
  const [saved, setSaved] = useState(false);

  const [entries, setEntries] = useState<Entries>(() => {
    const source = agent?.composition ?? emptyComposition();
    return {
      analysis: source.analysis.map((key) => ({ uid: nextUid(), key })),
      implementation: source.implementation.map((key) => ({ uid: nextUid(), key })),
      verification: source.verification.map((key) => ({ uid: nextUid(), key })),
      delivery: source.delivery.map((key) => ({ uid: nextUid(), key })),
    };
  });
  const [dragging, setDragging] = useState<Block | null>(null);

  // Making delivery composable makes its order expressible, and therefore breakable. The rules the
  // worker used to hold in code — nothing merges unreviewed, nothing merges that was never opened —
  // now have to be read off the sequence.
  const sequence = BUCKETS.flatMap((b) => entries[b.id].map((e) => e.key));
  const at = (key: string) => sequence.indexOf(key);
  const before = (a: string, b: string) => at(a) !== -1 && (at(b) === -1 || at(b) > at(a));

  const problems: string[] = [];
  const mergeAt = at("merge");
  if (mergeAt !== -1 && !sequence.slice(0, mergeAt).some((k) => lookup(k)?.gateKind === "review")) {
    problems.push(
      "Merge runs with nothing having reviewed the change. Put a Reviewed gate before it, or take the Merge step out and let a human decide."
    );
  }
  if (mergeAt !== -1 && !before("pull-request", "merge")) {
    problems.push("Merge runs without a pull request to merge. Put Pull request before it.");
  }
  if (at("pull-request") !== -1 && !before("push", "pull-request")) {
    problems.push("Pull request opens on a branch that was never pushed. Put Push before it.");
  }

  // Only an agent that writes needs a push. One that just reads and judges has nothing to send,
  // and demanding it there would be noise.
  const lastWriteAt = sequence.reduce(
    (last, key, i) => (lookup(key)?.capability === "edit" ? i : last),
    -1
  );
  if (lastWriteAt !== -1 && (at("push") === -1 || at("push") < lastWriteAt)) {
    problems.push(
      at("push") === -1
        ? "Nothing pushes the work, so it stays in a worktree on the machine and nobody can reach it. Add a Push step."
        : "Push runs before the last step that changes files, so what it sends is not the finished work."
    );
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const bucketOf = useMemo(
    () => (uid: string) =>
      BUCKETS.map((b) => b.id).find((id) => entries[id].some((e) => e.uid === uid)),
    [entries]
  );

  function resolveTarget(overId: string): { bucket: BucketId; index: number } | null {
    if (overId.startsWith(BUCKET_PREFIX)) {
      const bucket = overId.slice(BUCKET_PREFIX.length) as BucketId;
      return { bucket, index: entries[bucket].length };
    }
    const bucket = bucketOf(overId);
    if (!bucket) return null;
    return { bucket, index: entries[bucket].findIndex((e) => e.uid === overId) };
  }

  function handleDragStart({ active }: DragStartEvent) {
    const id = String(active.id);
    const key = id.startsWith(NEW_PREFIX) ? id.slice(NEW_PREFIX.length) : entriesKey(id);
    setDragging(lookup(key ?? "") ?? null);
  }

  function entriesKey(uid: string): string | undefined {
    for (const b of BUCKETS) {
      const found = entries[b.id].find((e) => e.uid === uid);
      if (found) return found.key;
    }
    return undefined;
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    if (!over) return;

    const activeId = String(active.id);
    const target = resolveTarget(String(over.id));
    if (!target) return;

    if (activeId.startsWith(NEW_PREFIX)) {
      const key = activeId.slice(NEW_PREFIX.length);
      setEntries((prev) => {
        const next = { ...prev, [target.bucket]: [...prev[target.bucket]] };
        next[target.bucket].splice(target.index, 0, { uid: nextUid(), key });
        return next;
      });
      return;
    }

    const from = bucketOf(activeId);
    if (!from) return;

    setEntries((prev) => {
      const fromIndex = prev[from].findIndex((e) => e.uid === activeId);
      if (from === target.bucket) {
        if (fromIndex === target.index) return prev;
        return { ...prev, [from]: arrayMove(prev[from], fromIndex, target.index) };
      }
      const moved = prev[from][fromIndex];
      const nextFrom = prev[from].filter((e) => e.uid !== activeId);
      const nextTo = [...prev[target.bucket]];
      nextTo.splice(target.index, 0, moved);
      return { ...prev, [from]: nextFrom, [target.bucket]: nextTo };
    });
  }

  const remove = (uid: string) =>
    setEntries((prev) => {
      const bucket = BUCKETS.map((b) => b.id).find((id) => prev[id].some((e) => e.uid === uid));
      if (!bucket) return prev;
      return { ...prev, [bucket]: prev[bucket].filter((e) => e.uid !== uid) };
    });

  if (!agent) {
    return (
      <>
        <PageHeader title="Agent" subtitle="Not found" />
        <p className="text-[13px] text-text-muted">
          No agent with that id. <Link href="/agents" className="text-primary">Back to agents</Link>.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={agent.name}
        subtitle={agent.description}
        actions={
          <>
            <Link href="/agents">
              <Button size="sm" variant="secondary">
                Back
              </Button>
            </Link>
            <Button
              size="sm"
              onClick={() => {
                store.saveComposition(agent.id, {
                  analysis: entries.analysis.map((e) => e.key),
                  implementation: entries.implementation.map((e) => e.key),
                  verification: entries.verification.map((e) => e.key),
                  delivery: entries.delivery.map((e) => e.key),
                });
                setSaved(true);
                window.setTimeout(() => setSaved(false), 2000);
              }}
            >
              {saved ? "Saved" : "Save"}
            </Button>
          </>
        }
      />

      {problems.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5">
          {problems.map((problem) => (
            <li key={problem} className="text-[13px] text-danger">
              {problem}
            </li>
          ))}
        </ul>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div>
            {BUCKETS.map((b) => (
              <Bucket
                key={b.id}
                id={b.id}
                label={b.label}
                hint={b.hint}
                entries={entries[b.id]}
                lookup={lookup}
                onRemove={remove}
              />
            ))}
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start">
            <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Steps</h2>
            <p className="mb-2 mt-1 text-[12px] text-text-muted">Work. Each one is a fresh session.</p>
            <ul className="mb-5 flex flex-col gap-2">
              {store.allSteps.map((block) => (
                <PaletteItem key={block.key} block={block} />
              ))}
            </ul>

            <h2 className="text-[10.5px] font-bold uppercase tracking-wider text-text-muted">Gates</h2>
            <p className="mb-2 mt-1 text-[12px] text-text-muted">Checks. They only say yes or no.</p>
            <ul className="flex flex-col gap-2">
              {store.allGates.map((block) => (
                <PaletteItem key={block.key} block={block} />
              ))}
            </ul>
          </aside>
        </div>

        <DragOverlay>
          {dragging && (
            <div className="rounded-lg border border-primary bg-bg-card px-3 py-2 shadow-lg">
              <BlockBody block={dragging} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}
