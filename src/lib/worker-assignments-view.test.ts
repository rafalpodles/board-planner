import { describe, it, expect } from "vitest";
import {
  assignmentProblem,
  describeProblem,
  hasChanged,
  withAssignment,
  withoutAssignment,
} from "./worker-assignments-view";

const CP = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "6a705baf749036e9ae754e1c";

describe("assignmentProblem", () => {
  it("accepts an absolute path for a project the worker does not serve yet", () => {
    expect(assignmentProblem([], { project: CP, proposedPath: "/Users/rpo/code/app" })).toBeNull();
  });

  it("refuses an empty project", () => {
    expect(assignmentProblem([], { project: "", proposedPath: "/x" })).toEqual({ kind: "no-project" });
  });

  it("refuses an empty path", () => {
    expect(assignmentProblem([], { project: CP, proposedPath: "  " })).toEqual({ kind: "no-path" });
  });

  // repos.ts refuses a relative path outright, so accepting one here would produce an assignment
  // that silently never binds — the worker just reports it unbound on the next heartbeat.
  it("refuses a relative path, which the worker would never bind", () => {
    expect(assignmentProblem([], { project: CP, proposedPath: "code/app" })).toEqual({
      kind: "relative-path",
      path: "code/app",
    });
  });

  it("refuses a second assignment for a project the worker already serves", () => {
    const existing = [{ project: CP, proposedPath: "/a" }];

    expect(assignmentProblem(existing, { project: CP, proposedPath: "/b" })).toMatchObject({
      kind: "duplicate",
    });
  });

  it("allows a different project on the same machine", () => {
    const existing = [{ project: CP, proposedPath: "/a" }];

    expect(assignmentProblem(existing, { project: OTHER, proposedPath: "/b" })).toBeNull();
  });

  it("trims before judging, so trailing space is not a path", () => {
    expect(assignmentProblem([], { project: CP, proposedPath: "   " })).toEqual({ kind: "no-path" });
  });
});

describe("describeProblem", () => {
  it("names the offending path when it is not absolute", () => {
    expect(describeProblem({ kind: "relative-path", path: "code/app" })).toContain("code/app");
    expect(describeProblem({ kind: "relative-path", path: "code/app" })).toMatch(/absolute/i);
  });

  it("has wording for every problem it can report", () => {
    const problems = [
      { kind: "no-project" },
      { kind: "no-path" },
      { kind: "relative-path", path: "x" },
      { kind: "duplicate", path: "x" },
    ] as const;

    for (const problem of problems) expect(describeProblem(problem).length).toBeGreaterThan(0);
  });
});

describe("editing the list", () => {
  it("adds a trimmed assignment", () => {
    expect(withAssignment([], { project: CP, proposedPath: " /a " })).toEqual([
      { project: CP, proposedPath: "/a" },
    ]);
  });

  it("removes by project", () => {
    const drafts = [
      { project: CP, proposedPath: "/a" },
      { project: OTHER, proposedPath: "/b" },
    ];

    expect(withoutAssignment(drafts, CP)).toEqual([{ project: OTHER, proposedPath: "/b" }]);
  });
});

describe("hasChanged", () => {
  it("is false for the same set in a different order", () => {
    const a = [
      { project: CP, proposedPath: "/a" },
      { project: OTHER, proposedPath: "/b" },
    ];
    const b = [
      { project: OTHER, proposedPath: "/b" },
      { project: CP, proposedPath: "/a" },
    ];

    expect(hasChanged(a, b)).toBe(false);
  });

  it("is true when a path changed", () => {
    expect(
      hasChanged([{ project: CP, proposedPath: "/a" }], [{ project: CP, proposedPath: "/z" }])
    ).toBe(true);
  });

  it("is true when one is removed", () => {
    expect(hasChanged([{ project: CP, proposedPath: "/a" }], [])).toBe(true);
  });
});
