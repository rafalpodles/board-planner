import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchTaskBranches, matchMRsToTasks, parseGitlabRepo } from "./gitlab";

// Hoisted, the way every other spec in this repo declares one: `vi.mock` is lifted above the module
// body, so a plain `const` is not initialised when the factory runs.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock("./safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-fetch")>()),
  safeFetch,
}));

// A unit test must not be able to reach the network even if the mock above ever stops applying
vi.stubGlobal("fetch", () => {
  throw new Error("a unit test reached the network");
});

/**
 * BP-429. `matchPRsToTasks` took `formerKeys` and this did not: the GitLab half was written from the
 * GitHub half and the argument was left behind. A renamed project's merge requests simply stopped
 * being found — nothing errored, nothing warned, and the link history thinned out at the rename.
 */

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
    // "B." unescaped matches "bx-7"; escaped it matches only a literal "B.". Asserting the branch
    // that DOES contain "b." would pass either way — the fixture would be doing the work, not the
    // escaping. src/lib/github.test.ts had this right and this was written weaker.
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
    // Without the filter the alternation becomes "(?:BP|)[- ](\\d+)", which matches "chore-3"
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

  // BP-611, the GitLab half. The same regex was built twice; the hole was in both copies, and
  // both now come from `projectKeyPattern`.
  it("does not find the key inside a longer word", () => {
    const matched = matchMRsToTasks(
      [mr({ branch: "feat/websubp-99", title: "BP-5 real work" })],
      "BP"
    );
    expect(matched.map((m) => m.matchedTaskNumber)).toEqual([5]);
  });

  it("still matches the key after a separator", () => {
    expect(matchMRsToTasks([mr({ branch: "feat/bp-7/slug" })], "BP")).toHaveLength(1);
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

/**
 * BP-611's other half. The lookbehind went into `taskKeyPattern` here at the same time as the
 * shared `projectKeyPattern`, and this side shipped with no test of any kind — the branch list a
 * task shows is filtered locally, so the defect the ticket describes (`websucp-5` listed among
 * CP-5's branches) lives in this function as much as in the matcher (found in review).
 */
describe("fetchTaskBranches — which branch belongs to a task", () => {
  const branch = (name: string) => ({
    name,
    web_url: `https://gitlab.com/g/p/-/tree/${name}`,
    commit: { committed_date: "2026-08-01T00:00:00Z" },
  });

  const answering = (names: string[]) =>
    safeFetch.mockResolvedValue(
      new Response(JSON.stringify(names.map(branch)), { status: 200 })
    );

  const branchesFor = (key: string) =>
    fetchTaskBranches("https://gitlab.com", "g/p", "token", key);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes the shapes a person writes a key in", async () => {
    answering(["CP-5", "cp-5/slug", "CP 5", "feature/CP-5-fix"]);

    expect((await branchesFor("CP-5")).map((b) => b.name)).toEqual([
      "CP-5",
      "cp-5/slug",
      "CP 5",
      "feature/CP-5-fix",
    ]);
  });

  it("does not take a key that is the tail of a longer word", async () => {
    // The ticket's own example, and the reason the lookbehind is there: two-letter keys sit inside
    // ordinary words, and `websucp-5` was listed as CP-5's branch
    answering(["websucp-5", "mycp-5"]);

    expect(await branchesFor("CP-5")).toEqual([]);
  });

  it("still takes a key somebody prefixed with a word and a hyphen", async () => {
    // A hyphen IS the boundary, on purpose and on both providers: `wip-cp-5` is how people label
    // a branch, and the lookbehind excludes letters and digits rather than punctuation
    answering(["wip-cp-5"]);

    expect((await branchesFor("CP-5")).map((b) => b.name)).toEqual(["wip-cp-5"]);
  });

  it("does not take a longer number that starts with this one", async () => {
    answering(["CP-50", "CP-5"]);

    expect((await branchesFor("CP-5")).map((b) => b.name)).toEqual(["CP-5"]);
  });

  it("keeps the number of a key that has hyphens of its own", async () => {
    // Split on the LAST hyphen: on the first, "MY" is the key and every branch with a number
    // matches
    answering(["MY-PROJ-5/x", "MY-PROJ-6/x"]);

    expect((await branchesFor("MY-PROJ-5")).map((b) => b.name)).toEqual(["MY-PROJ-5/x"]);
  });

  it("carries the branch through with its url and its last commit", async () => {
    answering(["CP-5/x"]);

    expect(await branchesFor("CP-5")).toEqual([
      {
        name: "CP-5/x",
        url: "https://gitlab.com/g/p/-/tree/CP-5/x",
        lastCommitAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
  });
});
