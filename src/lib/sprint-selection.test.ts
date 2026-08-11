import { describe, it, expect } from "vitest";
import { ApiSprint } from "@/types";
import { groupSprints, defaultSprintId, resolveSelectedSprint } from "./sprint-selection";

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

describe("defaultSprintId", () => {
  it("picks the active sprint with newest start date when multiple exist", () => {
    const sprints = [
      sprint({ _id: "a1", status: "active", startDate: "2026-08-01T00:00:00Z" }),
      sprint({ _id: "a2", status: "active", startDate: "2026-08-10T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("a2");
  });

  it("picks the planned sprint that starts soonest when none is active", () => {
    const sprints = [
      sprint({ _id: "later", startDate: "2026-09-01T00:00:00Z" }),
      sprint({ _id: "sooner", startDate: "2026-08-20T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("sooner");
  });

  it("falls back to the most recently completed sprint", () => {
    const sprints = [
      sprint({ _id: "old", status: "completed", endDate: "2026-06-01T00:00:00Z" }),
      sprint({ _id: "recent", status: "completed", endDate: "2026-07-01T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("recent");
  });

  it("has no answer for a project with no sprints", () => {
    expect(defaultSprintId([])).toBeNull();
  });

  it("breaks ties on startDate using _id as secondary sort key", () => {
    const sprints = [
      sprint({ _id: "z", status: "planned", startDate: "2026-08-20T00:00:00Z" }),
      sprint({ _id: "a", status: "planned", startDate: "2026-08-20T00:00:00Z" }),
    ];
    expect(defaultSprintId(sprints)).toBe("a");
  });

  it("tolerates null startDate and sorts it last", () => {
    const sprints = [
      sprint({ _id: "valid", status: "planned", startDate: "2026-08-20T00:00:00Z" }),
      sprint({ _id: "broken", status: "planned", startDate: null as any }),
    ];
    expect(defaultSprintId(sprints)).toBe("valid");
  });
});

describe("resolveSelectedSprint", () => {
  it("honours a requested sprint that exists", () => {
    const sprints = [sprint({ _id: "a1", status: "active" }), sprint({ _id: "p1" })];
    expect(resolveSelectedSprint(sprints, "p1")).toBe("p1");
  });

  it("falls back to the default when the requested sprint is gone", () => {
    const sprints = [sprint({ _id: "a1", status: "active" })];
    expect(resolveSelectedSprint(sprints, "deleted-id")).toBe("a1");
  });

  it("falls back to the default for a value that is not an id at all", () => {
    const sprints = [sprint({ _id: "a1", status: "active" })];
    expect(resolveSelectedSprint(sprints, "../../etc/passwd")).toBe("a1");
  });
});

describe("groupSprints", () => {
  it("keeps the three most recent completed sprints out of the older pile", () => {
    const completed = ["c1", "c2", "c3", "c4"].map((id, i) =>
      sprint({ _id: id, status: "completed", endDate: `2026-0${i + 1}-01T00:00:00Z` })
    );
    const grouped = groupSprints(completed);
    expect(grouped.recentCompleted.map((s) => s._id)).toEqual(["c4", "c3", "c2"]);
    expect(grouped.olderCompleted.map((s) => s._id)).toEqual(["c1"]);
  });

  it("does not mutate the input array", () => {
    const sprints = [
      sprint({ _id: "c1", status: "completed", endDate: "2026-02-01T00:00:00Z" }),
      sprint({ _id: "p1", status: "planned", startDate: "2026-09-01T00:00:00Z" }),
    ];
    const original = JSON.stringify(sprints);
    groupSprints(sprints);
    expect(JSON.stringify(sprints)).toBe(original);
  });
});
