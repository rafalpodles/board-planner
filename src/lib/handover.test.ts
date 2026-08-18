import { describe, it, expect } from "vitest";
import { handoverOf } from "./handover";
import { ApiTask, ApiUser } from "@/types";

const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal" } as ApiUser;
const KRZYSIEK = { _id: "u2", username: "kmk", fullName: "Krzysiek" };

const APPROVED = ["todo"];

function task(over: Partial<ApiTask> = {}): Parameters<typeof handoverOf>[0] {
  return { agent: "a1", assignee: RAFAL, assignedBy: { ...RAFAL }, status: "todo", ...over } as ApiTask;
}

/**
 * The claim takes a task or it does not, and says nothing either way. This is the only thing that
 * can tell somebody who chose an agent and watched nothing happen why nothing happened.
 */
describe("handoverOf", () => {
  it("runs a task its assignee handed to themselves", () => {
    expect(handoverOf(task(), APPROVED)).toEqual({ runs: true });
  });

  /**
   * The everyday false positive without it: pick an agent on a task still in the backlog, assign
   * it to yourself, and every other requirement passes while no claim ever looks at that column.
   */
  it("names a task sitting outside the approved column", () => {
    expect(handoverOf(task({ status: "planned" }), APPROVED)).toEqual({
      runs: false,
      reason: "not-approved-yet",
      by: null,
    });
  });

  // Choosing no agent is the more useful thing to say, and the ordinary case besides
  it("still names the missing agent first, wherever the task sits", () => {
    expect(handoverOf(task({ agent: null, status: "planned" }), APPROVED)).toMatchObject({
      reason: "no-agent",
    });
  });

  // A caller that does not know the board's columns must not have that requirement invented for
  // it — omitted means unjudged, not failed
  it("does not judge the column when it is not told which ones are approved", () => {
    expect(handoverOf(task({ status: "planned" }))).toEqual({ runs: true });
  });

  // A board may define more than one approved-role column
  it("accepts any of the approved columns", () => {
    expect(handoverOf(task({ status: "in_review" }), ["todo", "in_review"])).toEqual({ runs: true });
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
