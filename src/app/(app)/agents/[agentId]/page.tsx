"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  CollisionDetection,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { agentProblems } from "@/lib/agent-rules";
import { BUCKETS } from "../catalog";
import { useStore } from "../store";
import { useComposition } from "../useComposition";
import { BlockBody, Bucket, Palette } from "../components/blocks";

// Corner distance picks a neighbouring bucket's first row over the bucket the cursor is actually
// inside; the pointer is the only honest signal here. rectIntersection is the keyboard fallback,
// where there is no pointer at all.
const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  return byPointer.length > 0 ? byPointer : rectIntersection(args);
};

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const store = useStore();
  const agent = store.allAgents.find((a) => a._id === params.agentId);

  const lookup = (key: string) => [...store.allSteps, ...store.allGates].find((b) => b.key === key);
  const { entries, dragging, composition, onDragStart, onDragEnd, remove } = useComposition(
    agent?.composition,
    lookup
  );

  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState("");
  const problems = agentProblems(composition, lookup);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (store.loading) return <PageHeader title="Agent" subtitle="Loading" />;

  if (!agent) {
    return (
      <>
        <PageHeader title="Agent" subtitle="Not found" />
        <p className="text-[13px] text-text-muted">
          No agent with that id.{" "}
          <Link href="/agents" className="text-primary">
            Back to agents
          </Link>
          .
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
              onClick={async () => {
                setRefusal("");
                try {
                  await store.saveComposition(agent._id, composition);
                  setSaved(true);
                  window.setTimeout(() => setSaved(false), 2000);
                } catch (error) {
                  setRefusal(error instanceof Error ? error.message : "Could not save");
                }
              }}
            >
              {saved ? "Saved" : "Save"}
            </Button>
          </>
        }
      />

      {refusal && (
        <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
          Not saved. {refusal}
        </p>
      )}

      {problems.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1.5">
          {problems.map((problem) => (
            <li
              key={problem.message}
              className={`rounded-lg border px-3.5 py-2.5 text-[13px] ${
                problem.severity === "broken"
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-warning/40 bg-warning/10 text-warning"
              }`}
            >
              {problem.message}
            </li>
          ))}
        </ul>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div>
            {BUCKETS.map((bucket) => (
              <Bucket
                key={bucket.id}
                id={bucket.id}
                label={bucket.label}
                hint={bucket.hint}
                entries={entries[bucket.id]}
                lookup={lookup}
                onRemove={remove}
              />
            ))}
          </div>

          <Palette steps={store.allSteps} gates={store.allGates} />
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
