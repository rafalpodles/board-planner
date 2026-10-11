import { describe, it, expect } from "vitest";
import { checkSprintFields } from "./sprint-fields";

const valid = { name: "Sprint 1", startDate: "2026-10-12", endDate: "2026-10-25" };

describe("checkSprintFields", () => {
  it("reads a well-formed sprint into typed fields — the control", () => {
    const result = checkSprintFields({ ...valid, goal: "Ship it", status: "active" });

    expect(result).toEqual({
      ok: true,
      updates: {
        name: "Sprint 1",
        goal: "Ship it",
        status: "active",
        startDate: new Date("2026-10-12"),
        endDate: new Date("2026-10-25"),
      },
    });
  });

  it("accepts a one-day sprint", () => {
    expect(checkSprintFields({ ...valid, endDate: valid.startDate }).ok).toBe(true);
  });

  it.each([
    ["an unknown status", { status: "nope" }, "Invalid sprint status"],
    ["an empty status", { status: "" }, "Invalid sprint status"],
    ["a blank name", { name: "   " }, "A sprint needs a name"],
    ["a name that is not text", { name: 7 }, "A sprint needs a name"],
    ["a goal that is not text", { goal: { text: "x" } }, "Invalid goal"],
    ["an unreadable start date", { startDate: "yesterday" }, "Invalid startDate"],
    ["an unreadable end date", { endDate: "soon" }, "Invalid endDate"],
    ["a date that is not text", { startDate: 5 }, "Invalid startDate"],
    ["an end before the start", { startDate: "2026-10-25", endDate: "2026-10-12" }, "endDate must not be before startDate"],
  ])("refuses %s", (_, change, error) => {
    expect(checkSprintFields({ ...valid, ...change })).toEqual({ ok: false, error });
  });

  it("checks only what is sent, so an update may change one field", () => {
    expect(checkSprintFields({ name: "Renamed" })).toEqual({ ok: true, updates: { name: "Renamed" } });
    expect(checkSprintFields({})).toEqual({ ok: true, updates: {} });
  });

  it("compares a lone date with the stored one", () => {
    const stored = { startDate: new Date("2026-10-12"), endDate: new Date("2026-10-25") };

    expect(checkSprintFields({ endDate: "2026-10-01" }, stored)).toEqual({
      ok: false,
      error: "endDate must not be before startDate",
    });
    expect(checkSprintFields({ startDate: "2026-11-01" }, stored)).toEqual({
      ok: false,
      error: "endDate must not be before startDate",
    });
    expect(checkSprintFields({ endDate: "2026-11-01" }, stored).ok).toBe(true);
  });
});
