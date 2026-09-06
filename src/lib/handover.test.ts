import { describe, it, expect } from "vitest";
import { handoverOf } from "./handover";
import { ApiTask, ApiUser } from "@/types";
import type { AnyColumn } from "@/lib/columns";

const RAFAL = { _id: "u1", username: "rpo", fullName: "Rafal" } as ApiUser;
const KRZYSIEK = { _id: "u2", username: "kmk", fullName: "Krzysiek" };

const BOARD: AnyColumn[] = [
  { id: "someday", label: "Someday", color: "#888", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#888", role: "approved", order: 1 },
  { id: "doing", label: "Doing", color: "#888", role: "active", order: 2 },
  { id: "parked", label: "Parked", color: "#888", role: "blocked", order: 3 },
  { id: "checking", label: "Checking", color: "#888", role: "review", order: 4 },
  { id: "shipped", label: "Shipped", color: "#888", role: "done", order: 5 },
];

function task(over: Partial<Omit<ApiTask, "status">> & { status?: string } = {}): Parameters<typeof handoverOf>[0] {
  return { agent: "a1", assignee: RAFAL, assignedBy: { ...RAFAL }, status: "ready", ...over } as ApiTask;
}

describe("handoverOf", () => {
  it("runs a task its assignee handed to themselves", () => {
    expect(handoverOf(task(), BOARD)).toEqual({ runs: true });
  });

  it("names a task sitting in a column the work has not been approved out of", () => {
    expect(handoverOf(task({ status: "someday" }), BOARD)).toEqual({
      runs: false,
      reason: "not-approved-yet",
      by: null,
    });
  });

  it.each([
    ["active", "doing"],
    ["review", "checking"],
    ["done", "shipped"],
  ])("says nothing about a task in the %s column, which is past that question", (_role, status) => {
    expect(handoverOf(task({ status }), BOARD)).toEqual({ runs: true });
  });

  it("still names a blocked task as one nothing will pick up", () => {
    expect(handoverOf(task({ status: "parked" }), BOARD)).toMatchObject({
      reason: "not-approved-yet",
    });
  });

  it("names a task whose status matches no column this board has", () => {
    expect(handoverOf(task({ status: "a-column-somebody-deleted" }), BOARD)).toMatchObject({
      reason: "not-approved-yet",
    });
  });

  it("still names the missing agent first, wherever the task sits", () => {
    expect(handoverOf(task({ agent: null, status: "someday" }), BOARD)).toMatchObject({
      reason: "no-agent",
    });
  });

  it("does not judge the column when it is not told what the board is", () => {
    expect(handoverOf(task({ status: "someday" }))).toEqual({ runs: true });
  });

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

  it("names a task assigned before the board recorded who assigns", () => {
    expect(handoverOf(task({ assignedBy: undefined }))).toEqual({
      runs: false,
      reason: "assigner-unrecorded",
      by: null,
    });
  });

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

describe("handoverOf and a PM hand-over", () => {
  const PM = { _id: "pm1", username: "pm", fullName: "PM Agent" };

  it("runs when the PM assigned it on the assignee's own instruction", () => {
    expect(
      handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: { ...RAFAL } }), BOARD)
    ).toEqual({ runs: true });
  });

  it("refuses when the PM assigned it on somebody else's instruction", () => {
    expect(
      handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: { ...KRZYSIEK } }), BOARD)
    ).toEqual({ runs: false, reason: "pm-assigned-for-someone-else", by: "PM Agent" });
  });

  it("refuses when the PM assigned it with nobody driving the turn", () => {
    expect(handoverOf(task({ assignedBy: { ...PM }, pmAssignedFor: null }), BOARD)).toEqual({
      runs: false,
      reason: "pm-assigned-for-someone-else",
      by: "PM Agent",
    });
  });

  it("cannot recognise the PM through a bare id, and errs towards refusing", () => {
    expect(handoverOf(task({ assignedBy: "pm1", pmAssignedFor: "u1" }), BOARD)).toEqual({
      runs: false,
      reason: "assigned-by-someone-else",
      by: null,
    });
  });

  it("does not let a stray pmAssignedFor turn a colleague's assignment into a hand-over", () => {
    expect(
      handoverOf(task({ assignedBy: { ...KRZYSIEK }, pmAssignedFor: { ...RAFAL } }), BOARD)
    ).toEqual({ runs: false, reason: "assigned-by-someone-else", by: "Krzysiek" });
  });
});
