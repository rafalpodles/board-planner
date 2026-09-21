import { describe, it, expect } from "vitest";
import { awaitingClaim, handoverOf } from "./handover";
import { ApiTask, ApiUser } from "@/types";
import type { AnyColumn } from "@/lib/columns";

const OWNER = { _id: "u1", username: "owner", fullName: "Owner" } as ApiUser;
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
  return { agent: "a1", assignee: OWNER, assignedBy: { ...OWNER }, status: "ready", ...over } as ApiTask;
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
    expect(handoverOf(task({ status: "someday" }), BOARD)).toEqual({ runs: false, problems: [{ reason: "not-approved-yet", by: null }] });
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
    expect(handoverOf(task({ status: "parked" }), BOARD)).toMatchObject({ problems: [{ reason: "not-approved-yet" }] });
  });

  // What a task left behind by a deleted column carries. Nowhere a claim looks either.
  it("names a task whose status matches no column this board has", () => {
    expect(handoverOf(task({ status: "a-column-somebody-deleted" }), BOARD)).toMatchObject({ problems: [{ reason: "not-approved-yet" }] });
  });

  // Choosing no agent is the more useful thing to say, and the ordinary case besides
  it("still names the missing agent first, wherever the task sits", () => {
    expect(handoverOf(task({ agent: null, status: "someday" }), BOARD)).toMatchObject({ problems: [{ reason: "no-agent" }] });
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
    expect(handoverOf(task({ assignedBy: "u2" }))).toMatchObject({ problems: [{ reason: "assigned-by-someone-else" }] });
  });

  it("names choosing no agent as the reason before anything else", () => {
    expect(handoverOf(task({ agent: null, assignee: null }))).toEqual({ runs: false, problems: [{ reason: "no-agent", by: null }] });
  });

  it("names an unassigned task, which belongs to nobody", () => {
    expect(handoverOf(task({ assignee: null }))).toEqual({ runs: false, problems: [{ reason: "unassigned", by: null }] });
  });

  // The whole of the legacy case: every task stored before BP-358 has no assignedBy key, nothing
  // backfills it, and the claim refuses it. This is where the product says so.
  it("names a task assigned before the board recorded who assigns", () => {
    expect(handoverOf(task({ assignedBy: undefined }))).toEqual({ runs: false, problems: [{ reason: "assigner-unrecorded", by: null }] });
  });

  // Populate renders a reference to a deleted user as null, and typeof null is "object" — a check
  // on the type rather than the value would read this as a live assigner and promise a run
  it("treats an assigner whose account is gone as unrecorded, not as the assignee", () => {
    expect(handoverOf(task({ assignedBy: null }))).toMatchObject({ problems: [{ reason: "assigner-unrecorded" }] });
  });

  it("names who handed it over when somebody else did", () => {
    expect(handoverOf(task({ assignedBy: KRZYSIEK }))).toEqual({ runs: false, problems: [{ reason: "assigned-by-someone-else", by: "Krzysiek" }] });
  });

  it("falls back to the username when that account has no display name", () => {
    expect(handoverOf(task({ assignedBy: { ...KRZYSIEK, fullName: "" } }))).toMatchObject({ problems: [{ by: "kmk" }] });
  });
});

/**
 * BP-419. The claim admits a PM hand-over, paired with the person who asked for it. This row has to
 * agree with that filter in both directions, and the dangerous direction is `runs: true` over a task
 * the server refuses — the reader is then told to expect a run that never comes.
 */
describe("handoverOf and a PM hand-over", () => {
  const PM = { _id: "pm1", username: "pm", fullName: "PM Agent" };

  it("runs when the PM assigned it on the assignee's own instruction", () => {
    expect(
      handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: { ...OWNER } }), BOARD)
    ).toEqual({ runs: true });
  });

  it("refuses when the PM assigned it on somebody else's instruction", () => {
    expect(
      handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: { ...KRZYSIEK } }), BOARD)
    ).toEqual({ runs: false, problems: [{ reason: "pm-assigned-for-someone-else", by: "PM Agent" }] });
  });

  // An unattended turn — a board review, a needs-human-review trigger — records nobody
  it("refuses when the PM assigned it with nobody driving the turn", () => {
    expect(handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: null }), BOARD)).toEqual({ runs: false, problems: [{ reason: "pm-assigned-for-someone-else", by: "PM Agent" }] });
  });

  /**
   * The limit of judging by username, stated as a test so it cannot quietly stop being true. A
   * writer echoing back what it sent carries a bare id, and this function cannot tell the PM from
   * anyone else then — it reads as an ordinary third party. Kept honest in the safe direction:
   * "nothing will run this" about a task that might, never the reverse.
   */
  it("cannot recognise the PM through a bare id, and errs towards refusing", () => {
    expect(handoverOf(task({ assignedBy: "pm1", pmAssignedFor: "u1" }), BOARD)).toEqual({ runs: false, problems: [{ reason: "assigned-by-someone-else", by: null }] });
  });

  // The control: a person is still not the PM, whatever pmAssignedFor happens to say
  it("does not let a stray pmAssignedFor turn a colleague's assignment into a hand-over", () => {
    expect(
      handoverOf(task({ assignedBy: { ...KRZYSIEK }, pmAssignedFor: { ...OWNER } }), BOARD)
    ).toEqual({ runs: false, problems: [{ reason: "assigned-by-someone-else", by: "Krzysiek" }] });
  });
});

/**
 * BP-728. Fixing one requirement used to reveal the next, one at a time. The column and the
 * assignee are independent requirements, so both are reported together; the assignee-side reasons
 * exclude each other, so there are never more than two.
 */
describe("handoverOf, several requirements at once", () => {
  it("names a backlog task with nobody on it for both", () => {
    expect(handoverOf(task({ status: "someday", assignee: null }), BOARD)).toEqual({
      runs: false,
      problems: [
        { reason: "not-approved-yet", by: null },
        { reason: "unassigned", by: null },
      ],
    });
  });

  it.each([
    [{ assignedBy: undefined }, "assigner-unrecorded", null],
    [{ assignedBy: KRZYSIEK }, "assigned-by-someone-else", "Krzysiek"],
    [
      { assignedBy: { _id: "pm1", username: "pm", fullName: "PM Agent" }, pmAssignedFor: KRZYSIEK },
      "pm-assigned-for-someone-else",
      "PM Agent",
    ],
  ])("pairs the column with %o", (over, reason, by) => {
    expect(handoverOf(task({ status: "parked", ...over }), BOARD)).toEqual({
      runs: false,
      problems: [
        { reason: "not-approved-yet", by: null },
        { reason, by },
      ],
    });
  });

  // The control for each pairing above: in the approved column only the assignee-side reason is left
  it("reports only the assignee side once the column is right", () => {
    expect(handoverOf(task({ assignee: null }), BOARD)).toEqual({
      runs: false,
      problems: [{ reason: "unassigned", by: null }],
    });
  });

  it("reports nothing else when no agent is chosen, however much else is missing", () => {
    expect(handoverOf(task({ agent: null, status: "someday", assignee: null }), BOARD)).toEqual({
      runs: false,
      problems: [{ reason: "no-agent", by: null }],
    });
  });
});

describe("awaitingClaim", () => {
  it.each([
    ["someday", true],
    ["ready", true],
    ["parked", true],
    ["a-column-somebody-deleted", true],
    ["doing", false],
    ["checking", false],
    ["shipped", false],
  ])("treats %s as awaiting a claim: %s", (status, expected) => {
    expect(awaitingClaim(BOARD, status)).toBe(expected);
  });
});

/** BP-727 review: the claim leaves a task alone while a blocker is unfinished. */
describe("handoverOf and blockers", () => {
  const link = (taskNumber: number, status: string) => ({
    _id: `b${taskNumber}`,
    taskNumber,
    title: "",
    status,
  });

  it("names the unfinished blockers, not the finished ones", () => {
    expect(
      handoverOf(task({ blockedBy: [link(3, "doing"), link(4, "shipped"), link(5, "parked")] } as never), BOARD)
    ).toEqual({ runs: false, problems: [{ reason: "blocked", by: null, blockers: [3, 5] }] });
  });

  it("runs once every blocker is done", () => {
    expect(handoverOf(task({ blockedBy: [link(4, "shipped")] } as never), BOARD)).toEqual({ runs: true });
  });

  // A bare id carries no status, and guessing would invent a blocker or hide one
  it("does not judge a blocker that arrived as a bare id", () => {
    expect(handoverOf(task({ blockedBy: ["b9"] } as never), BOARD)).toEqual({ runs: true });
  });

  // Populated without its status (a narrower projection somewhere) is as unknown as a bare id
  it("does not judge a blocker that arrived without its status", () => {
    expect(handoverOf(task({ blockedBy: [{ _id: "b9", taskNumber: 9 }] } as never), BOARD)).toEqual({
      runs: true,
    });
  });

  it("does not judge blockers without the board's columns", () => {
    expect(handoverOf(task({ blockedBy: [link(3, "doing")] } as never))).toEqual({ runs: true });
  });

  it("lists a blocker alongside the task's other problems", () => {
    expect(
      handoverOf(task({ status: "someday", assignee: null, blockedBy: [link(3, "doing")] } as never), BOARD)
    ).toMatchObject({
      problems: [{ reason: "not-approved-yet" }, { reason: "unassigned" }, { reason: "blocked" }],
    });
  });
});
