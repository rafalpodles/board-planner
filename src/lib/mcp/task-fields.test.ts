import { describe, it, expect } from "vitest";
import { dueDateValue, recurrenceValue, sprintClears, sprintForWrite } from "./task-fields";

describe("dueDateValue", () => {
  it("passes a day and clears on an empty string", () => {
    expect(dueDateValue("2026-10-10")).toBe("2026-10-10");
    expect(dueDateValue("")).toBeNull();
  });

  it.each(["2026-02-31", "2026-13-01", "10/10/2026", "tomorrow", "2026-10-10T10:00:00Z", "2026-1-5"])(
    "refuses %s, which is not a day that exists",
    (value) => {
      expect(() => dueDateValue(value)).toThrow(/Invalid dueDate/);
    }
  );

  it("bounds what it quotes back", () => {
    expect(() => dueDateValue("x".repeat(5_000))).toThrow(/Invalid dueDate "x{64}…"/);
  });
});

describe("recurrenceValue", () => {
  it("clears on null", () => {
    expect(recurrenceValue(null)).toBeNull();
  });

  it("passes the series through, with its end only when it has one", () => {
    expect(recurrenceValue({ frequency: "weekly", interval: 2 })).toEqual({ frequency: "weekly", interval: 2 });
    expect(recurrenceValue({ frequency: "daily", interval: 1, endDate: "2026-12-31" })).toEqual({
      frequency: "daily",
      interval: 1,
      endDate: "2026-12-31",
    });
    expect(recurrenceValue({ frequency: "daily", interval: 1, endDate: "" })).toEqual({ frequency: "daily", interval: 1 });
  });

  it("reads a null end as no end, which is what get_task hands back for a series without one", () => {
    expect(recurrenceValue({ frequency: "daily", interval: 1, endDate: null })).toEqual({ frequency: "daily", interval: 1 });
  });

  it("refuses an end that is not a day", () => {
    expect(() => recurrenceValue({ frequency: "daily", interval: 1, endDate: "2026-02-31" })).toThrow(
      /Invalid recurrence endDate/
    );
  });
});

describe("sprintForWrite", () => {
  const SPRINTS = [
    { _id: "507f1f77bcf86cd799439011", name: "Sprint 4", status: "active" },
    { _id: "507f1f77bcf86cd799439012", name: "Hardening", status: "planned" },
    { _id: "507f1f77bcf86cd799439013", name: "Old", status: "completed" },
  ];

  it("finds a sprint by name in any case, or by an id this board has, in either case", () => {
    expect(sprintForWrite("hardening", SPRINTS)).toBe("507f1f77bcf86cd799439012");
    expect(sprintForWrite("507f1f77bcf86cd799439011", SPRINTS)).toBe("507f1f77bcf86cd799439011");
    expect(sprintForWrite("507F1F77BCF86CD799439011", SPRINTS)).toBe("507f1f77bcf86cd799439011");
  });

  it("takes the task out of its sprint on backlog or an empty string", () => {
    expect(sprintForWrite("backlog", SPRINTS)).toBeNull();
    expect(sprintForWrite("Backlog", SPRINTS)).toBeNull();
    expect(sprintForWrite("", SPRINTS)).toBeNull();
    expect(sprintClears("  ")).toBe(true);
    expect(sprintClears("Sprint 4")).toBe(false);
  });

  // The create route drops a sprint of another board without a word, answering 200 for a task in no sprint
  it("refuses an id that is not this board's, instead of letting the route drop it", () => {
    expect(() => sprintForWrite("507f1f77bcf86cd7994390ff", SPRINTS)).toThrow(/No sprint "507f1f77bcf86cd7994390ff"/);
  });

  it("refuses a completed sprint: the screens never offer one, and it would move the closed counts", () => {
    expect(() => sprintForWrite("Old", SPRINTS)).toThrow(/Sprint "Old" is completed/);
    expect(() => sprintForWrite("507f1f77bcf86cd799439013", SPRINTS)).toThrow(/is completed/);
  });

  it("refuses a name two sprints share, with their ids and states, instead of taking the first", () => {
    const twins = [
      { _id: "507f1f77bcf86cd799439021", name: "Sprint 4", status: "completed" },
      { _id: "507f1f77bcf86cd799439022", name: "sprint 4", status: "planned" },
    ];

    expect(() => sprintForWrite("Sprint 4", twins)).toThrow(
      /2 sprints are named "Sprint 4".*507f1f77bcf86cd799439021 \(completed\), 507f1f77bcf86cd799439022 \(planned\)/
    );
    // ...and the id of the planned one still works
    expect(sprintForWrite("507f1f77bcf86cd799439022", twins)).toBe("507f1f77bcf86cd799439022");
  });

  it("names the sprints the board has when nothing matches", () => {
    expect(() => sprintForWrite("Nope", SPRINTS)).toThrow(/Sprints: Sprint 4, Hardening, Old/);
    expect(() => sprintForWrite("Nope", [])).toThrow(/Sprints: none/);
  });
});
