import { describe, it, expect } from "vitest";
import { ApiSprint } from "@/types";
import { nextSprintDates, overlappingSprint } from "./sprint-defaults";

function sprint(over: Partial<ApiSprint> & { _id: string }): ApiSprint {
  return {
    name: over._id,
    startDate: "2026-08-01T00:00:00Z",
    endDate: "2026-08-15T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
    ...over,
  } as ApiSprint;
}

describe("nextSprintDates", () => {
  // Local, not `new Date("…T00:00:00Z")`. `today` stands for the day the person is having, and the
  // only caller is a client component passing `new Date()` in the browser; `toDateInput` reads it
  // with local getters, which is right — somebody in Los Angeles creating a sprint on the 10th
  // should be offered the 10th. A UTC instant as the fixture is a different day for everybody west
  // of UTC, so these two cases failed there and nowhere else (BP-487). Noon so no zone's midnight
  // shift can move it.
  const localNoonOn = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 12, 0, 0);

  it("chains onto the previous sprint's end date", () => {
    const sprints = [sprint({ _id: "s1", startDate: "2026-08-01T00:00:00Z", endDate: "2026-08-15T00:00:00Z" })];
    const today = localNoonOn(2026, 8, 5);
    expect(nextSprintDates(sprints, today)).toEqual({
      startDate: "2026-08-15",
      endDate: "2026-08-29",
    });
  });

  it("falls back to today when the latest sprint has a null startDate", () => {
    const sprints = [sprint({ _id: "broken", startDate: null as unknown as string })];
    const today = localNoonOn(2026, 8, 11);
    expect(nextSprintDates(sprints, today)).toEqual({
      startDate: "2026-08-11",
      endDate: "2026-08-25",
    });
  });

  it("falls back to today when the latest sprint has a null endDate", () => {
    const sprints = [sprint({ _id: "broken", endDate: null as unknown as string })];
    const today = localNoonOn(2026, 8, 11);
    expect(nextSprintDates(sprints, today)).toEqual({
      startDate: "2026-08-11",
      endDate: "2026-08-25",
    });
  });
});

describe("overlappingSprint", () => {
  it("finds a genuinely overlapping sprint", () => {
    const sprints = [sprint({ _id: "s1", startDate: "2026-08-01T00:00:00Z", endDate: "2026-08-15T00:00:00Z" })];
    expect(overlappingSprint(sprints, "2026-08-10", "2026-08-20")?._id).toBe("s1");
  });

  it("skips a sprint with a null startDate instead of throwing", () => {
    const sprints = [sprint({ _id: "broken", startDate: null as unknown as string })];
    expect(() => overlappingSprint(sprints, "2026-08-01", "2026-08-15")).not.toThrow();
    expect(overlappingSprint(sprints, "2026-08-01", "2026-08-15")).toBeNull();
  });

  it("skips a sprint with a null endDate instead of throwing", () => {
    const sprints = [sprint({ _id: "broken", endDate: null as unknown as string })];
    expect(() => overlappingSprint(sprints, "2026-08-01", "2026-08-15")).not.toThrow();
    expect(overlappingSprint(sprints, "2026-08-01", "2026-08-15")).toBeNull();
  });

  it("still finds a real overlap alongside a malformed sprint", () => {
    const sprints = [
      sprint({ _id: "broken", startDate: null as unknown as string }),
      sprint({ _id: "valid", startDate: "2026-08-01T00:00:00Z", endDate: "2026-08-15T00:00:00Z" }),
    ];
    expect(overlappingSprint(sprints, "2026-08-10", "2026-08-20")?._id).toBe("valid");
  });
});
