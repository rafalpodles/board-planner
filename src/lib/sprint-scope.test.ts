import { describe, it, expect } from "vitest";
import {
  sprintScopeFromParam,
  sprintScopeToQuery,
  sprintScopeLabel,
  boardSubtitle,
} from "./sprint-scope";
import { ApiSprint } from "@/types";

const sprints = [
  { _id: "s1", name: "Sprint 12", status: "active" },
  { _id: "s2", name: "Sprint 13", status: "planned" },
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
    expect(sprintScopeFromParam("s1")).toBe("s1");
    expect(sprintScopeFromParam("backlog")).toBe("backlog");
  });
});

describe("sprintScopeToQuery", () => {
  // An unscoped board must not carry ?sprint=all around — the URL should look untouched
  it("produces no query string for the unscoped board", () => {
    expect(sprintScopeToQuery("all")).toBe("");
  });

  it("serialises a scope", () => {
    expect(sprintScopeToQuery("s1")).toBe("?sprint=s1");
    expect(sprintScopeToQuery("backlog")).toBe("?sprint=backlog");
  });

  it("round-trips through the parser", () => {
    for (const scope of ["all", "backlog", "s1"]) {
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
    expect(sprintScopeLabel("s1", sprints)).toBe("Sprint 12");
    expect(sprintScopeLabel("s2", sprints)).toBe("Sprint 13");
  });

  // A shared link can outlive the sprint it points at; a raw ObjectId in the
  // subtitle would be worse than showing nothing
  it("has no label for a sprint that no longer exists", () => {
    expect(sprintScopeLabel("deleted-id", sprints)).toBeNull();
    expect(sprintScopeLabel("s1", [])).toBeNull();
  });
});

describe("boardSubtitle", () => {
  it("omits the scope segment when unscoped", () => {
    expect(boardSubtitle(null, 30)).toBe("Board · 30 tasks");
  });

  it("includes the scope segment when scoped", () => {
    expect(boardSubtitle("Sprint 12", 8)).toBe("Board · Sprint 12 · 8 tasks");
    expect(boardSubtitle("Backlog", 4)).toBe("Board · Backlog · 4 tasks");
  });

  it("says one task, not 1 tasks", () => {
    expect(boardSubtitle(null, 1)).toBe("Board · 1 task");
    expect(boardSubtitle("Sprint 12", 1)).toBe("Board · Sprint 12 · 1 task");
  });

  it("handles an empty board", () => {
    expect(boardSubtitle(null, 0)).toBe("Board · 0 tasks");
  });
});
