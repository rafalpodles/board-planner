// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TaskCard } from "@/components/kanban/TaskCard";
import { RunDot } from "@/components/kanban/RunDot";
import { ExecutionPanel } from "@/components/tasks/ExecutionPanel";
import { QUIET_MS } from "@/lib/run-state";
import { ApiTask, ApiTaskExecution } from "@/types";

/**
 * The three views each drew the run indicator themselves and drifted apart: the card and the list
 * row painted a live run red while the execution panel painted the same run green, so opening a
 * task changed what its state appeared to be. Nothing failed — no test compared the two.
 *
 * So this renders all three from one execution object and compares what they actually produce,
 * rather than asserting the shared helper returns what the shared helper returns.
 */

const NOW = "2026-08-01T12:00:00.000Z";
const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString();

const execution = (msSincePhase: number): ApiTaskExecution =>
  ({
    workerId: "w1",
    workerName: "mac-mini",
    phase: "agent",
    phaseAt: at(msSincePhase),
    startedAt: at(msSincePhase + 60_000),
    asOf: NOW,
  }) as ApiTaskExecution;

const task = (execution: ApiTaskExecution) =>
  ({
    _id: "t1",
    taskNumber: 7,
    title: "A task",
    status: "in_progress",
    priority: "medium",
    category: "bug",
    createdAt: NOW,
    updatedAt: NOW,
    execution,
  }) as ApiTask;

/** The classes on the round indicator, whichever view drew it. */
function dotClasses(container: HTMLElement): string {
  const dot = container.querySelector("span.rounded-full");
  expect(dot, "no indicator rendered").toBeTruthy();
  return (dot as HTMLElement).className;
}

function colourOf(classes: string): string | undefined {
  return classes.split(/\s+/).find((c) => c.startsWith("bg-"));
}

afterEach(cleanup);

describe("the run indicator, across every view that draws one", () => {
  for (const [state, sincePhase] of [
    ["live", 1_000],
    ["quiet", QUIET_MS + 60_000],
  ] as const) {
    it(`agrees on the colour of a ${state} run`, () => {
      const run = execution(sincePhase);

      const card = render(<TaskCard task={task(run)} projectKey="TP" onClick={() => {}} />);
      const cardColour = colourOf(dotClasses(card.container));
      cleanup();

      const row = render(<RunDot execution={run} />);
      const rowColour = colourOf(dotClasses(row.container));
      cleanup();

      const panel = render(<ExecutionPanel execution={run} />);
      const panelColour = colourOf(dotClasses(panel.container));

      expect(cardColour, "the card drew no colour").toBeTruthy();
      expect({ row: rowColour, panel: panelColour }).toEqual({
        row: cardColour,
        panel: cardColour,
      });
    });
  }

  // The two states have to stay apart, or agreement would be satisfiable by painting both alike
  it("keeps live and quiet visually different", () => {
    const live = render(<RunDot execution={execution(1_000)} />);
    const liveColour = colourOf(dotClasses(live.container));
    cleanup();
    const quiet = render(<RunDot execution={execution(QUIET_MS + 60_000)} />);

    expect(colourOf(dotClasses(quiet.container))).not.toBe(liveColour);
  });
});

/**
 * Reduced motion drops `animate-pulse`, so anything that only distinguishes the two states while
 * it is running is not a distinction at all for the people who asked motion to stop. The colours
 * left over — danger red and warning amber — are the pair the most common colour-vision
 * deficiency separates worst, on a target six pixels across.
 */
describe("telling a live run from a quiet one without motion or colour", () => {
  const still = (classes: string) =>
    classes
      .split(/\s+/)
      .filter((c) => !c.startsWith("animate-") && !c.startsWith("motion-reduce:"))
      .join(" ");

  it("differs by more than colour once every animated class is removed", () => {
    const live = render(<RunDot execution={execution(1_000)} />);
    const liveStill = still(dotClasses(live.container));
    cleanup();
    const quiet = render(<RunDot execution={execution(QUIET_MS + 60_000)} />);
    const quietStill = still(dotClasses(quiet.container));

    // Anything whose value names a palette entry is colour, whatever property carries it —
    // `ring-danger/40` is as much a colour as `bg-danger`, while `ring-2` is a width. An earlier
    // version stripped only `bg-`, so putting a differently-coloured ring on both states read as
    // a structural difference and the test passed on exactly the bug it exists for.
    const structural = (c: string) => !/^(bg|text|ring|border|outline|shadow)-[a-z]/.test(c);
    const shapeOf = (c: string) => c.split(/\s+/).filter(structural).sort().join(" ");
    expect(shapeOf(liveStill), "the two states differ only by colour").not.toBe(shapeOf(quietStill));
  });

  // A cue hidden behind motion-reduce: would be absent for everyone else, and a cue behind a
  // motion query at all would be absent for exactly the people who need it
  it("carries the distinguishing cue unconditionally, not behind a motion variant", () => {
    const live = render(<RunDot execution={execution(1_000)} />);
    const ring = dotClasses(live.container)
      .split(/\s+/)
      .filter((c) => c.includes("ring"));

    expect(ring.length, "no ring on a live run").toBeGreaterThan(0);
    expect(ring.every((c) => !c.startsWith("motion-reduce:")), `${ring} is behind a motion variant`).toBe(true);
  });
});
