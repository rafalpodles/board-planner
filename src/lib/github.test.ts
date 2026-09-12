import { describe, it, expect } from "vitest";
import { matchPRsToTasks, pullRequestIsElsewhere, pullRequestRepository } from "./github";

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

/**
 * BP-610. Repointing a project at another repository strands every link from the old one, and no
 * amount of syncing the new repository ever contradicts them by number — the numbers simply mean
 * something else now. The URL is the only evidence, so it has to be read carefully enough that an
 * unfamiliar shape removes nothing.
 */
describe("pullRequestRepository", () => {
  it("reads the owner and repository out of a pull request URL", () => {
    expect(pullRequestRepository("https://github.com/o/r/pull/12")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  it("refuses anything that is not a github.com pull request", () => {
    expect(pullRequestRepository("https://gitlab.com/g/p/-/merge_requests/12")).toBeNull();
    expect(pullRequestRepository("https://github.com/o/r/issues/12")).toBeNull();
    expect(pullRequestRepository("https://evil.test/github.com/o/r/pull/12")).toBeNull();
    expect(pullRequestRepository("not-a-url")).toBeNull();
  });
});

describe("pullRequestIsElsewhere", () => {
  it("says so when the link names a different repository", () => {
    expect(pullRequestIsElsewhere("https://github.com/other/repo/pull/12", "o", "r")).toBe(true);
  });

  it("keeps a link from the repository the project is pointed at", () => {
    expect(pullRequestIsElsewhere("https://github.com/o/r/pull/12", "o", "r")).toBe(false);
  });

  it("does not mind how GitHub cased the owner and repository", () => {
    expect(pullRequestIsElsewhere("https://github.com/O/R/pull/12", "o", "r")).toBe(false);
  });

  /**
   * The conservative half: a URL nobody anticipated must not delete a link. Only a positive
   * reading of another owner and repository removes anything.
   */
  it("keeps a link whose URL it cannot read", () => {
    expect(pullRequestIsElsewhere("not-a-url", "o", "r")).toBe(false);
    expect(pullRequestIsElsewhere("https://ghe.example.test/o/r/pull/12", "o", "r")).toBe(false);
  });
});
