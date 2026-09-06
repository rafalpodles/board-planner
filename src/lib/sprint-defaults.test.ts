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

  it("offers the day the person is having, not the UTC day", () => {
    const wasTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const today = new Date(2026, 7, 11, 20, 0, 0);
      expect(today.getTimezoneOffset(), "the timezone did not actually change").toBe(420);
      expect(today.toISOString().slice(0, 10)).toBe("2026-08-12");

      const sprints = [sprint({ _id: "broken", startDate: null as unknown as string })];
      expect(nextSprintDates(sprints, today).startDate).toBe("2026-08-11");
    } finally {
      if (wasTz === undefined) delete process.env.TZ;
      else process.env.TZ = wasTz;
    }
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
