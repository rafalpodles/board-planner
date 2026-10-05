import { describe, it, expect } from "vitest";
import sift from "sift";
import { NOT_ARCHIVED, archivedFilter, archivedScopeOf } from "./task-archive";

const live = { title: "a" };
const never = { title: "b", archivedAt: null };
const archived = { title: "c", archivedAt: new Date() };
const matching = (filter: Record<string, unknown>) => [live, never, archived].filter(sift(filter)).map((t) => t.title);

describe("the filter that hides archived tasks", () => {
  it("keeps a task nobody archived, whether the field is null or was never written, and drops the rest", () => {
    expect(matching({ ...NOT_ARCHIVED })).toEqual(["a", "b"]);
  });

  it("is what a reader gets by default", () => {
    expect(archivedFilter("exclude")).toEqual(NOT_ARCHIVED);
    expect(archivedScopeOf(null)).toBe("exclude");
    expect(archivedScopeOf("")).toBe("exclude");
  });

  it("finds only the archived with only, and everything with include", () => {
    expect(matching(archivedFilter("only"))).toEqual(["c"]);
    expect(matching(archivedFilter("include"))).toEqual(["a", "b", "c"]);
  });

  it("knows no other scope", () => {
    expect(archivedScopeOf("yes")).toBeNull();
    expect(archivedScopeOf("exclude")).toBe("exclude");
    expect(archivedScopeOf("only")).toBe("only");
    expect(archivedScopeOf("include")).toBe("include");
  });
});
