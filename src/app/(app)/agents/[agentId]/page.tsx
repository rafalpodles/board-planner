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
import { useAuth } from "@/hooks/use-auth";
import { useProjects } from "@/hooks/use-projects";
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
  const { isAdmin } = useAuth();
  const { projects } = useProjects();
  const agent = store.allAgents.find((a) => a._id === params.agentId);

  /**
   * The same three answers `mayEdit` gives on the server (`api/agents/[agentId]/route.ts`).
   * A personal agent needs no owner check here: `/api/agents` only ever sends the reader their
   * own, so `scope: "user"` in this list always means mine.
   *
   * Without this the palette, the drag, the remove buttons and Save were all rendered to
   * everybody — a member could spend a minute rearranging Default's gates and learn only on
   * pressing Save that it was never theirs to change. The catalog one level up already withholds
   * its actions "where it would 403"; this is that, one screen down.
   */
  const mayEdit =
    agent?.scope === "user" ||
    (agent?.scope === "project"
      ? !!projects.find((p) => p._id === agent.projectId)?.canAdmin
      : isAdmin);

  const lookup = (key: string) => [...store.allSteps, ...store.allGates].find((b) => b.key === key);
  const { entries, dragging, composition, onDragStart, onDragEnd, remove } = useComposition(
    agent?.composition,
    lookup
  );

  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState("");
  // `store.renameAgent` and `PUT /api/agents/:id`'s name/description have existed since the
  // catalog was written and nothing ever called them, so a typo in an agent's name was permanent
  // short of delete-and-recreate — which the in-use guard may itself refuse.
  const [naming, setNaming] = useState<{ name: string; description: string } | null>(null);
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
            {/* Not the shipped three: `agent-seed.ts` finds them by NAME, so renaming one makes
                the next seed mint a second agent called Default beside it. The route does not
                refuse it — that gap is worth its own ticket; withholding the affordance is what
                this screen can do about it today. */}
            {mayEdit && !agent.builtIn && !naming && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setNaming({ name: agent.name, description: agent.description })}
              >
                Rename
              </Button>
            )}
            {mayEdit && (
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
            )}
          </>
        }
      />

      {naming && (
        <form
          className="mb-4 flex flex-col gap-2 rounded-lg border border-border bg-bg-card p-3.5 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            setRefusal("");
            try {
              await store.renameAgent(agent._id, naming.name.trim(), naming.description.trim());
              setNaming(null);
            } catch (error) {
              setRefusal(error instanceof Error ? error.message : "Could not rename");
            }
          }}
        >
          <input
            aria-label="Agent name"
            value={naming.name}
            onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            className="focus-ring min-h-11 flex-1 rounded-lg border border-border bg-bg-input px-2.5 text-sm"
          />
          <input
            aria-label="Agent description"
            value={naming.description}
            onChange={(e) => setNaming({ ...naming, description: e.target.value })}
            className="focus-ring min-h-11 flex-[2] rounded-lg border border-border bg-bg-input px-2.5 text-sm"
          />
          <Button size="sm" type="submit" disabled={!naming.name.trim()}>
            Save name
          </Button>
          <Button size="sm" type="button" variant="secondary" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}

      {!mayEdit && (
        <p
          data-testid="agent-read-only"
          className="mb-4 rounded-lg border border-border bg-bg-card px-3.5 py-2.5 text-[13px] text-text-muted"
        >
          {agent.scope === "project"
            ? "A project admin composes this project's agents. You can read it here."
            : "An instance admin composes the shipped agents. You can read it here."}
        </p>
      )}

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
                readOnly={!mayEdit}
                onRemove={remove}
              />
            ))}
          </div>

          {mayEdit && <Palette steps={store.allSteps} gates={store.allGates} />}
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
