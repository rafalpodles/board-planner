import { describe, it, expect } from "vitest";
import { matchPRsToTasks } from "./github";

/**
 * A task key is built from the project's current key, so renaming the key renames every
 * task at once — while the branches and pull-request titles already on GitHub keep the
 * prefix they were created with. Without the former keys, a rename silently unlinks the
 * entire history: nothing errors, the sync just quietly matches less than it used to.
 */

const pr = (over: Partial<{ number: number; title: string; ref: string }> = {}) => ({
  number: over.number ?? 1,
  title: over.title ?? "Some change",
  state: "open" as const,
  merged_at: null,
  updated_at: "2026-08-01T00:00:00Z",
  html_url: "https://github.com/o/r/pull/1",
  head: { ref: over.ref ?? "feature/x" },
});

describe("matchPRsToTasks", () => {
  it("matches the current key on a branch name and on a title", () => {
    const matched = matchPRsToTasks(
      [pr({ number: 1, ref: "bp-250/history" }), pr({ number: 2, title: "BP-9 fix", ref: "x" })],
      "BP"
    );
    expect(matched.map((m) => [m.number, m.matchedTaskNumber])).toEqual([[1, 250], [2, 9]]);
  });

  it("still matches pull requests opened under a key the project has since left", () => {
    const matched = matchPRsToTasks([pr({ ref: "cp-250/field-activity-history" })], "BP", ["CP"]);
    expect(matched.map((m) => m.matchedTaskNumber)).toEqual([250]);
  });

  it("loses that history when the former key is not carried", () => {
    expect(matchPRsToTasks([pr({ ref: "cp-250/field-activity-history" })], "BP")).toEqual([]);
  });

  it("matches any of several former keys", () => {
    const matched = matchPRsToTasks(
      [pr({ number: 1, ref: "cp-1/a" }), pr({ number: 2, ref: "old-2/b" }), pr({ number: 3, ref: "bp-3/c" })],
      "BP",
      ["CP", "OLD"]
    );
    expect(matched.map((m) => m.matchedTaskNumber).sort()).toEqual([1, 2, 3]);
  });

  it("does not match a project it never was", () => {
    expect(matchPRsToTasks([pr({ ref: "zz-7/other" })], "BP", ["CP"])).toEqual([]);
  });

  // Keys are not format-validated, so one containing regex syntax must not widen the match
  it("treats a key with regex characters literally", () => {
    expect(matchPRsToTasks([pr({ ref: "cX-5/x" })], "C(", ["C."])).toEqual([]);
    expect(matchPRsToTasks([pr({ ref: "c(-5/x" })], "C(")).toHaveLength(1);
  });
});
