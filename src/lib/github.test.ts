import { describe, it, expect } from "vitest";
import { matchPRsToTasks, reduceChecks } from "./github";

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
 * The six states the badge can show come from here, and five of them are a reduction of two
 * independent GitHub mechanisms — check runs, and the older commit statuses a great many external
 * services still post. A repository using only the second would read grey without them.
 */

const run = (over: Partial<{ name: string; status: string; conclusion: string | null; completed_at: string }> = {}) => ({
  name: over.name ?? "build",
  status: over.status ?? "completed",
  conclusion: "conclusion" in over ? over.conclusion! : "success",
  completed_at: over.completed_at ?? "2026-09-01T10:00:00Z",
});

const noStatuses = { state: "pending", statuses: [] };

describe("reduceChecks", () => {
  it("says nothing has run when neither mechanism has anything", () => {
    expect(reduceChecks([], noStatuses)).toEqual({ ci: "none", ciLabel: null });
    expect(reduceChecks([], null)).toEqual({ ci: "none", ciLabel: null });
  });

  it("reads a finished, passing set as success and names the check that finished last", () => {
    expect(
      reduceChecks(
        [
          run({ name: "lint", completed_at: "2026-09-01T10:00:00Z" }),
          run({ name: "e2e", completed_at: "2026-09-01T11:00:00Z" }),
          run({ name: "unit", completed_at: "2026-09-01T09:00:00Z" }),
        ],
        noStatuses
      )
    ).toEqual({ ci: "success", ciLabel: "e2e" });
  });

  it("is running while any check has not completed, and names it", () => {
    expect(
      reduceChecks([run({ name: "lint" }), run({ name: "e2e", status: "in_progress", conclusion: null })], noStatuses)
    ).toEqual({ ci: "running", ciLabel: "e2e" });
    expect(reduceChecks([run({ name: "e2e", status: "queued", conclusion: null })], noStatuses).ci).toBe("running");
  });

  // The ordering choice worth stating: once a job has failed the answer is known, and a badge that
  // keeps spinning until an unrelated job finishes tells somebody to wait for news that has arrived
  it("calls it failed even while other checks are still running", () => {
    expect(
      reduceChecks(
        [run({ name: "unit", conclusion: "failure" }), run({ name: "e2e", status: "in_progress", conclusion: null })],
        noStatuses
      )
    ).toEqual({ ci: "failure", ciLabel: "unit" });
  });

  it("treats every conclusion that blocks a merge as a failure", () => {
    for (const conclusion of ["failure", "timed_out", "action_required", "cancelled", "startup_failure"]) {
      expect(reduceChecks([run({ name: conclusion, conclusion })], noStatuses), conclusion).toEqual({
        ci: "failure",
        ciLabel: conclusion,
      });
    }
  });

  // A workflow whose every job was skipped by a path filter is the ordinary case, not a red board
  it("treats the conclusions that decide nothing as passing", () => {
    for (const conclusion of ["neutral", "skipped", "stale"]) {
      expect(reduceChecks([run({ conclusion })], noStatuses).ci, conclusion).toBe("success");
    }
    // And they are never the label, because they decided nothing
    expect(reduceChecks([run({ name: "skipped-one", conclusion: "skipped" })], noStatuses).ciLabel).toBeNull();
  });

  describe("the commit-status mechanism, which check runs alone would miss", () => {
    it("reads a failing context as a failure and names it", () => {
      expect(
        reduceChecks([], { state: "failure", statuses: [{ context: "ci/circleci", state: "failure" }] })
      ).toEqual({ ci: "failure", ciLabel: "ci/circleci" });
    });

    it("reads an errored context as a failure too", () => {
      expect(reduceChecks([], { state: "error", statuses: [{ context: "ci/x", state: "error" }] }).ci).toBe(
        "failure"
      );
    });

    it("reads a pending context as running", () => {
      expect(
        reduceChecks([], { state: "pending", statuses: [{ context: "ci/circleci", state: "pending" }] })
      ).toEqual({ ci: "running", ciLabel: "ci/circleci" });
    });

    // GitHub answers `pending` with no contexts for a commit nothing has posted about at all, so
    // this is the reading that separates "nothing has run" from "something is running"
    it("does not call an empty pending answer running", () => {
      expect(reduceChecks([], { state: "pending", statuses: [] }).ci).toBe("none");
    });

    // Named, not merely green: a repository with no check runs has no other name for what passed,
    // and an empty tooltip is the whole difference between a badge and a coloured dot
    it("reads a passing context as success even with no check runs at all, and names it", () => {
      expect(
        reduceChecks([], { state: "success", statuses: [{ context: "ci/circleci", state: "success" }] })
      ).toEqual({ ci: "success", ciLabel: "ci/circleci" });
    });

    // The check run is the richer source, so it wins the label where both have one
    it("prefers a check run's name over a context when both passed", () => {
      expect(
        reduceChecks([run({ name: "e2e" })], {
          state: "success",
          statuses: [{ context: "ci/circleci", state: "success" }],
        }).ciLabel
      ).toBe("e2e");
    });

    it("lets a failing context outrank a passing check run", () => {
      expect(
        reduceChecks([run({ name: "lint" })], {
          state: "failure",
          statuses: [{ context: "ci/circleci", state: "failure" }],
        }).ci
      ).toBe("failure");
    });
  });
});
