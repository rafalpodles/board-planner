import { describe, it, expect } from "vitest";
import { handoverOf } from "./handover";
import { ApiTask, ApiUser } from "@/types";
import type { AnyColumn } from "@/lib/columns";

const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal" } as ApiUser;
const KRZYSIEK = { _id: "u2", username: "kmk", fullName: "Krzysiek" };

// A board of its own rather than the seeded seven, so an implementation comparing against literal
// ids — "todo", "in_progress", "done" — fails every case here instead of passing by coincidence
const BOARD: AnyColumn[] = [
  { id: "someday", label: "Someday", color: "#888", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#888", role: "approved", order: 1 },
  { id: "doing", label: "Doing", color: "#888", role: "active", order: 2 },
  { id: "parked", label: "Parked", color: "#888", role: "blocked", order: 3 },
  { id: "checking", label: "Checking", color: "#888", role: "review", order: 4 },
  { id: "shipped", label: "Shipped", color: "#888", role: "done", order: 5 },
];

// `status` widened to a plain string: TaskStatus is the union of the SEEDED column ids, and a
// project that built its own board has ids outside it — which is the whole point of judging by role
function task(over: Partial<Omit<ApiTask, "status">> & { status?: string } = {}): Parameters<typeof handoverOf>[0] {
  return { agent: "a1", assignee: RAFAL, assignedBy: { ...RAFAL }, status: "ready", ...over } as ApiTask;
}

/**
 * The claim takes a task or it does not, and says nothing either way. This is the only thing that
 * can tell somebody who chose an agent and watched nothing happen why nothing happened.
 */
describe("handoverOf", () => {
  it("runs a task its assignee handed to themselves", () => {
    expect(handoverOf(task(), BOARD)).toEqual({ runs: true });
  });

  /**
   * The everyday false positive without it: pick an agent on a task still in the backlog, assign
   * it to yourself, and every other requirement passes while no claim ever looks at that column.
   */
  it("names a task sitting in a column the work has not been approved out of", () => {
    expect(handoverOf(task({ status: "someday" }), BOARD)).toEqual({
      runs: false,
      reason: "not-approved-yet",
      by: null,
    });
  });

  /**
   * The reason is "not there YET", and past the approved column it is the opposite of true: a task
   * in the active column may be under a machine at this moment, and the notice rendered beside the
   * live run indicator said nothing would run it. On a finished task it is nonsense.
   *
   * Each column is named by its ROLE here rather than by an approved-id list, which is what made
   * every one of these read as "not approved yet".
   */
  it.each([
    ["active", "doing"],
    ["review", "checking"],
    ["done", "shipped"],
  ])("says nothing about a task in the %s column, which is past that question", (_role, status) => {
    expect(handoverOf(task({ status }), BOARD)).toEqual({ runs: true });
  });

  // Parked, not taken: nothing claims it, and moving it back to the approved column is exactly
  // what would
  it("still names a blocked task as one nothing will pick up", () => {
    expect(handoverOf(task({ status: "parked" }), BOARD)).toMatchObject({
      reason: "not-approved-yet",
    });
  });

  // What a task left behind by a deleted column carries. Nowhere a claim looks either.
  it("names a task whose status matches no column this board has", () => {
    expect(handoverOf(task({ status: "a-column-somebody-deleted" }), BOARD)).toMatchObject({
      reason: "not-approved-yet",
    });
  });

  // Choosing no agent is the more useful thing to say, and the ordinary case besides
  it("still names the missing agent first, wherever the task sits", () => {
    expect(handoverOf(task({ agent: null, status: "someday" }), BOARD)).toMatchObject({
      reason: "no-agent",
    });
  });

  // A caller that does not know the board's columns must not have that requirement invented for
  // it — omitted means unjudged, not failed
  it("does not judge the column when it is not told what the board is", () => {
    expect(handoverOf(task({ status: "someday" }))).toEqual({ runs: true });
  });

  // A board may define more than one approved-role column
  it("accepts any of the approved columns", () => {
    const twoApproved: AnyColumn[] = [
      ...BOARD,
      { id: "also-ready", label: "Also ready", color: "#888", role: "approved", order: 6 },
    ];

    expect(handoverOf(task({ status: "also-ready" }), twoApproved)).toEqual({ runs: true });
  });

  it("compares by id, so an unpopulated reference is read the same way", () => {
    expect(handoverOf(task({ assignedBy: "u1" }))).toEqual({ runs: true });
    expect(handoverOf(task({ assignedBy: "u2" }))).toMatchObject({
      reason: "assigned-by-someone-else",
    });
  });

  it("names choosing no agent as the reason before anything else", () => {
    expect(handoverOf(task({ agent: null, assignee: null }))).toEqual({
      runs: false,
      reason: "no-agent",
      by: null,
    });
  });

  it("names an unassigned task, which belongs to nobody", () => {
    expect(handoverOf(task({ assignee: null }))).toEqual({
      runs: false,
      reason: "unassigned",
      by: null,
    });
  });

  // The whole of the legacy case: every task stored before BP-358 has no assignedBy key, nothing
  // backfills it, and the claim refuses it. This is where the product says so.
  it("names a task assigned before the board recorded who assigns", () => {
    expect(handoverOf(task({ assignedBy: undefined }))).toEqual({
      runs: false,
      reason: "assigner-unrecorded",
      by: null,
    });
  });

  // Populate renders a reference to a deleted user as null, and typeof null is "object" — a check
  // on the type rather than the value would read this as a live assigner and promise a run
  it("treats an assigner whose account is gone as unrecorded, not as the assignee", () => {
    expect(handoverOf(task({ assignedBy: null }))).toMatchObject({
      reason: "assigner-unrecorded",
    });
  });

  it("names who handed it over when somebody else did", () => {
    expect(handoverOf(task({ assignedBy: KRZYSIEK }))).toEqual({
      runs: false,
      reason: "assigned-by-someone-else",
      by: "Krzysiek",
    });
  });

  it("falls back to the username when that account has no display name", () => {
    expect(handoverOf(task({ assignedBy: { ...KRZYSIEK, fullName: "" } }))).toMatchObject({
      by: "kmk",
    });
  });
});
