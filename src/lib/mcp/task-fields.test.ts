import { describe, it, expect } from "vitest";
import { dueDateValue, recurrenceValue, sprintForWrite } from "./task-fields";

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

  it("refuses an end that is not a day", () => {
    expect(() => recurrenceValue({ frequency: "daily", interval: 1, endDate: "2026-02-31" })).toThrow(
      /Invalid recurrence endDate/
    );
  });
});

describe("sprintForWrite", () => {
  const SPRINTS = [
    { _id: "507f1f77bcf86cd799439011", name: "Sprint 4" },
    { _id: "507f1f77bcf86cd799439012", name: "Hardening" },
  ];

  it("finds a sprint by name in any case, or by an id this board has", () => {
    expect(sprintForWrite("hardening", SPRINTS)).toBe("507f1f77bcf86cd799439012");
    expect(sprintForWrite("507f1f77bcf86cd799439011", SPRINTS)).toBe("507f1f77bcf86cd799439011");
  });

  it("takes the task out of its sprint on backlog or an empty string", () => {
    expect(sprintForWrite("backlog", SPRINTS)).toBeNull();
    expect(sprintForWrite("Backlog", SPRINTS)).toBeNull();
    expect(sprintForWrite("", SPRINTS)).toBeNull();
  });

  // The create route drops a sprint of another board without a word, answering 200 for a task in no sprint
  it("refuses an id that is not this board's, instead of letting the route drop it", () => {
    expect(() => sprintForWrite("507f1f77bcf86cd7994390ff", SPRINTS)).toThrow(/No sprint named/);
  });

  it("names the sprints the board has when nothing matches", () => {
    expect(() => sprintForWrite("Nope", SPRINTS)).toThrow(/Sprints: Sprint 4, Hardening/);
    expect(() => sprintForWrite("Nope", [])).toThrow(/Sprints: none/);
  });
});
