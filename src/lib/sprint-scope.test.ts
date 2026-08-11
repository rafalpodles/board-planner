import { describe, it, expect } from "vitest";
import {
  sprintScopeFromParam,
  sprintScopeToQuery,
  sprintScopeLabel,
  sprintDefaultForNewTask,
  isSprintScopeShape,
} from "./sprint-scope";
import { ApiSprint } from "@/types";

const S1 = "507f1f77bcf86cd799439011";
const S2 = "69a52e3b399b27d3cbb2c5a5";

const sprints = [
  { _id: S1, name: "Sprint 12", status: "active" },
  { _id: S2, name: "Sprint 13", status: "planned" },
] as ApiSprint[];

describe("sprintScopeFromParam", () => {
  it("defaults to all when the param is absent", () => {
    expect(sprintScopeFromParam(null)).toBe("all");
    expect(sprintScopeFromParam(undefined)).toBe("all");
  });

  it("defaults to all for an empty or whitespace param", () => {
    expect(sprintScopeFromParam("")).toBe("all");
    expect(sprintScopeFromParam("   ")).toBe("all");
  });

  it("passes through a sprint id and the backlog sentinel", () => {
    expect(sprintScopeFromParam(S1)).toBe(S1);
    expect(sprintScopeFromParam("backlog")).toBe("backlog");
  });

  // A stale bookmark or a link to a sprint somebody deleted must not reach the tasks
  // endpoint as a raw string — it would cast into a Mongoose CastError and 500
  it("falls back to all for a value that cannot be a scope", () => {
    expect(sprintScopeFromParam("not-an-id")).toBe("all");
    expect(sprintScopeFromParam("deleted-sprint")).toBe("all");
  });
});

describe("isSprintScopeShape", () => {
  it("accepts the two modes and an ObjectId-shaped id", () => {
    expect(isSprintScopeShape("all")).toBe(true);
    expect(isSprintScopeShape("backlog")).toBe(true);
    expect(isSprintScopeShape(S1)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isSprintScopeShape("not-an-id")).toBe(false);
    expect(isSprintScopeShape("")).toBe(false);
  });
});

describe("sprintScopeToQuery", () => {
  // An unscoped board must not carry ?sprint=all around — the URL should look untouched
  it("produces no query string for the unscoped board", () => {
    expect(sprintScopeToQuery("all")).toBe("");
  });

  it("serialises a scope", () => {
    expect(sprintScopeToQuery(S1)).toBe(`?sprint=${S1}`);
    expect(sprintScopeToQuery("backlog")).toBe("?sprint=backlog");
  });

  it("round-trips through the parser", () => {
    for (const scope of ["all", "backlog", S1]) {
      const query = sprintScopeToQuery(scope);
      const param = query ? new URLSearchParams(query).get("sprint") : null;
      expect(sprintScopeFromParam(param)).toBe(scope);
    }
  });
});

describe("sprintScopeLabel", () => {
  it("has no label for the unscoped board", () => {
    expect(sprintScopeLabel("all", sprints)).toBeNull();
  });

  it("names the backlog", () => {
    expect(sprintScopeLabel("backlog", sprints)).toBe("Backlog");
  });

  it("resolves a sprint id to its name", () => {
    expect(sprintScopeLabel(S1, sprints)).toBe("Sprint 12");
    expect(sprintScopeLabel(S2, sprints)).toBe("Sprint 13");
  });

  // A shared link can outlive the sprint it points at; a raw ObjectId in the
  // subtitle would be worse than showing nothing
  it("has no label for a sprint that no longer exists", () => {
    expect(sprintScopeLabel("deleted-id", sprints)).toBeNull();
    expect(sprintScopeLabel(S1, [])).toBeNull();
  });
});

describe("sprintDefaultForNewTask", () => {
  // CP-176: without this the task saves with sprint null and the server filter
  // hides it from the very board that created it
  it("adopts the scoped sprint", () => {
    expect(sprintDefaultForNewTask(S1)).toBe(S1);
  });

  it("means no sprint for the unscoped board", () => {
    expect(sprintDefaultForNewTask("all")).toBe("");
  });

  // Backlog is defined as "no sprint", so adopting it would be self-contradictory
  it("means no sprint for the backlog scope", () => {
    expect(sprintDefaultForNewTask("backlog")).toBe("");
  });
});

