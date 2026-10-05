import { describe, it, expect } from "vitest";
import { findSprint, incompleteDestination, sprintSummary, type SprintRow } from "./sprints";

const SPRINTS: SprintRow[] = [
  { _id: "507f1f77bcf86cd799439011", name: "Sprint 4", status: "active" },
  { _id: "507f1f77bcf86cd799439012", name: "Hardening", status: "planned" },
  { _id: "507f1f77bcf86cd799439013", name: "Old", status: "completed" },
];

describe("findSprint", () => {
  it("finds a sprint by name in any case, or by an id in either case", () => {
    expect(findSprint("hardening", SPRINTS)._id).toBe("507f1f77bcf86cd799439012");
    expect(findSprint("507F1F77BCF86CD799439011", SPRINTS)._id).toBe("507f1f77bcf86cd799439011");
  });

  it("refuses a name two sprints share, with their ids and states", () => {
    const twins: SprintRow[] = [
      { _id: "507f1f77bcf86cd799439021", name: "Sprint 4", status: "completed" },
      { _id: "507f1f77bcf86cd799439022", name: "sprint 4", status: "planned" },
    ];

    expect(() => findSprint("Sprint 4", twins)).toThrow(
      /2 sprints are named "Sprint 4".*507f1f77bcf86cd799439021 \(completed\), 507f1f77bcf86cd799439022 \(planned\)/
    );
    expect(findSprint("507f1f77bcf86cd799439022", twins).status).toBe("planned");
  });

  it("names the sprints the board has when nothing matches, an id of another board included", () => {
    expect(() => findSprint("Nope", SPRINTS)).toThrow(/No sprint "Nope".*Sprint 4, Hardening, Old/);
    expect(() => findSprint("507f1f77bcf86cd7994390ff", SPRINTS)).toThrow(/No sprint "507f1f77bcf86cd7994390ff"/);
    expect(() => findSprint("x", [])).toThrow(/Sprints: none/);
  });
});

describe("incompleteDestination", () => {
  const [active, planned, completed] = SPRINTS;

  it("sends unfinished tasks to the backlog, or to another sprint by its id", () => {
    expect(incompleteDestination("Backlog", SPRINTS, active)).toEqual({ moveIncompleteToBacklog: true });
    expect(incompleteDestination("hardening", SPRINTS, active)).toEqual({ moveIncompleteToSprint: planned._id });
  });

  it("refuses the sprint being closed as its own destination, and a completed sprint", () => {
    expect(() => incompleteDestination("Sprint 4", SPRINTS, active)).toThrow(/its own destination/);
    expect(() => incompleteDestination("Old", SPRINTS, active)).toThrow(/is completed/);
    expect(completed.status).toBe("completed");
  });

  it("refuses a sprint the board does not have", () => {
    expect(() => incompleteDestination("Nope", SPRINTS, active)).toThrow(/No sprint "Nope"/);
  });
});

describe("sprintSummary", () => {
  it("answers with the id, the dates as days and the counts", () => {
    expect(
      sprintSummary({
        _id: "507f1f77bcf86cd799439011",
        name: "Sprint 4",
        status: "active",
        startDate: "2026-10-01T00:00:00.000Z",
        endDate: "2026-10-14T00:00:00.000Z",
        goal: "Ship it",
        taskCount: 5,
        doneCount: 2,
      })
    ).toEqual({
      id: "507f1f77bcf86cd799439011",
      name: "Sprint 4",
      status: "active",
      startDate: "2026-10-01",
      endDate: "2026-10-14",
      goal: "Ship it",
      taskCount: 5,
      doneCount: 2,
    });
  });
});
