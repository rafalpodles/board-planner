import { describe, it, expect } from "vitest";
import { matchMRsToTasks, parseGitlabRepo } from "./gitlab";

const mr = (
  over: Partial<{
    iid: number;
    title: string;
    branch: string;
    state: "opened" | "closed" | "merged" | "locked";
    merged_at: string | null;
  }> = {}
) => ({
  iid: over.iid ?? 1,
  title: over.title ?? "Some change",
  state: over.state ?? ("opened" as const),
  web_url: "https://gitlab.com/g/p/-/merge_requests/1",
  merged_at: over.merged_at ?? null,
  source_branch: over.branch ?? "feature/x",
  updated_at: "2026-08-01T00:00:00Z",
});

describe("matchMRsToTasks", () => {
  it("matches the current key on a branch name and on a title", () => {
    const matched = matchMRsToTasks(
      [mr({ iid: 1, branch: "bp-250/history" }), mr({ iid: 2, title: "BP-9 fix", branch: "x" })],
      "BP"
    );
    expect(matched.map((m) => [m.number, m.matchedTaskNumber])).toEqual([
      [1, 250],
      [2, 9],
    ]);
  });

  it("still matches merge requests opened under a key the project has since left", () => {
    const matched = matchMRsToTasks([mr({ branch: "cp-250/field-activity-history" })], "BP", ["CP"]);
    expect(matched.map((m) => m.matchedTaskNumber)).toEqual([250]);
  });

  it("loses that history when the former key is not carried — the bug this ticket is about", () => {
    expect(matchMRsToTasks([mr({ branch: "cp-250/field-activity-history" })], "BP")).toEqual([]);
  });

  it("matches any of several former keys", () => {
    const matched = matchMRsToTasks(
      [mr({ iid: 1, branch: "cp-1/a" }), mr({ iid: 2, branch: "old-2/b" }), mr({ iid: 3, branch: "bp-3/c" })],
      "BP",
      ["CP", "OLD"]
    );
    expect(matched.map((m) => m.matchedTaskNumber)).toEqual([1, 2, 3]);
  });

  it("ignores a merge request that names no key at all", () => {
    expect(matchMRsToTasks([mr({ branch: "chore/bump-deps", title: "Bump deps" })], "BP", ["CP"])).toEqual(
      []
    );
  });

  it("does not let a key be read as a regex", () => {
    expect(matchMRsToTasks([mr({ branch: "bx-7/any-letter" })], "BP", ["B."])).toEqual([]);
    expect(matchMRsToTasks([mr({ branch: "b.-7/literal" })], "BP", ["B."])).toHaveLength(1);
  });

  it("survives a former key that is not a valid regex on its own", () => {
    expect(() => matchMRsToTasks([mr({ branch: "c(-1/x" })], "BP", ["C("])).not.toThrow();
    expect(matchMRsToTasks([mr({ branch: "c(-1/x" })], "BP", ["C("])).toHaveLength(1);
  });

  it("does not match a longer key it is a prefix of", () => {
    expect(matchMRsToTasks([mr({ branch: "bpx-8/longer" })], "BP")).toEqual([]);
  });

  it("ignores an empty former key instead of matching every branch with a number", () => {
    expect(matchMRsToTasks([mr({ branch: "chore-3/unrelated" })], "BP", [""])).toEqual([]);
  });

  it("accepts a space between key and number, which the docstring promises", () => {
    expect(matchMRsToTasks([mr({ branch: "x", title: "BP 5 in a title" })], "BP")).toHaveLength(1);
  });

  it("reads a merged merge request as merged, and carries its merge time", () => {
    const [matched] = matchMRsToTasks(
      [mr({ branch: "bp-5/x", state: "merged", merged_at: "2026-08-02T10:00:00Z" })],
      "BP"
    );
    expect(matched.state).toBe("merged");
    expect(matched.mergedAt).toEqual(new Date("2026-08-02T10:00:00Z"));
  });

  it("maps GitLab's four states onto the three this app stores", () => {
    const states = (["opened", "closed", "merged", "locked"] as const).map(
      (state) => matchMRsToTasks([mr({ branch: "bp-5/x", state })], "BP")[0].state
    );
    expect(states).toEqual(["open", "closed", "merged", "closed"]);
  });

  it("prefers the branch over the title when the two name different tasks", () => {
    const [matched] = matchMRsToTasks([mr({ branch: "bp-11/a", title: "BP-22 b" })], "BP");
    expect(matched.matchedTaskNumber).toBe(11);
  });
});

describe("parseGitlabRepo", () => {
  it("accepts a group/project pair, a nested one, and a full URL on any host", () => {
    expect(parseGitlabRepo("group/project")).toBe("group/project");
    expect(parseGitlabRepo("group/sub/project")).toBe("group/sub/project");
    expect(parseGitlabRepo("https://gitlab.example.com/group/project.git")).toBe("group/project");
  });

  it("refuses what is not a path", () => {
    expect(parseGitlabRepo("  ")).toBeNull();
    expect(parseGitlabRepo("project")).toBeNull();
  });
});
