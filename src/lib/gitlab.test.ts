import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkGitlabToken,
  fetchMergeRequests,
  fetchMergedRequests,
  fetchTaskBranches,
  fetchTaskCommits,
  matchMRsToTasks,
  parseGitlabExpiry,
  parseGitlabRepo,
} from "./gitlab";

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
    expect(matched.map((m) => [m.number, ...m.matchedTaskNumbers])).toEqual([
      [1, 250],
      [2, 9],
    ]);
  });

  it("still matches merge requests opened under a key the project has since left", () => {
    const matched = matchMRsToTasks([mr({ branch: "cp-250/field-activity-history" })], "BP", ["CP"]);
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([250]);
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
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([1, 2, 3]);
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

  it("links every key in the branch and the title, each once (BP-635)", () => {
    const [matched] = matchMRsToTasks([mr({ branch: "bp-11/a", title: "BP-11, BP-22 and old-33" })], "BP", ["OLD"]);
    expect(matched.matchedTaskNumbers).toEqual([11, 22, 33]);
  });

  // BP-611, the GitLab half. The same regex was built twice; the hole was in both copies, and
  // both now come from `taskNumbersIn`.
  it("does not find the key inside a longer word", () => {
    const matched = matchMRsToTasks(
      [mr({ branch: "feat/websubp-99", title: "BP-5 real work" })],
      "BP"
    );
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([5]);
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
 * shared pattern behind `taskNumbersIn`, and this side shipped with no test of any kind — the branch list a
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

describe("the loopback carve-out that lets e2e/gitlab-stub.mjs be reached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeFetch.mockImplementation(() => Promise.resolve(new Response("[]", { status: 200 })));
  });

  it("every GitLab call allows loopback outside production", async () => {
    await fetchMergeRequests("http://127.0.0.1:9999", "g/p", "token");
    await fetchTaskBranches("http://127.0.0.1:9999", "g/p", "token", "CP-5");
    await fetchTaskCommits("http://127.0.0.1:9999", "g/p", "token", "CP-5");

    expect(safeFetch).toHaveBeenCalledTimes(3);
    for (const call of safeFetch.mock.calls) {
      expect(call[2]).toEqual({ allowLoopback: true });
    }
  });

  it("refuses loopback when the module is loaded in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const production = await import("./gitlab");
      expect(production.GITLAB_DESTINATION).toEqual({ allowLoopback: false });

      await production.fetchMergeRequests("http://127.0.0.1:9999", "g/p", "token");
      expect(safeFetch.mock.calls[0][2]).toEqual({ allowLoopback: false });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("fetchTaskCommits — which commit belongs to a task", () => {
  const hit = (title: string, message?: string) => ({
    id: `${title}-sha`,
    short_id: title.slice(0, 8),
    title,
    ...(message === undefined ? {} : { message }),
    author_name: "Ada",
    created_at: "2026-08-01T00:00:00Z",
  });

  const answering = (hits: ReturnType<typeof hit>[]) =>
    safeFetch.mockResolvedValue(new Response(JSON.stringify(hits), { status: 200 }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the task's own commit and drops a longer number the search matched as a substring", async () => {
    answering([hit("GL-3: fix"), hit("GL-30: other")]);

    const commits = await fetchTaskCommits("https://gitlab.com", "g/p", "token", "GL-3");

    expect(commits.map((c) => c.title)).toEqual(["GL-3: fix"]);
  });

  it("counts a key that appears only in the commit body", async () => {
    answering([hit("fix the header", "fix the header\n\nRefs GL-3"), hit("GL-30 other", "GL-30 other")]);

    const commits = await fetchTaskCommits("https://gitlab.com", "g/p", "token", "GL-3");

    expect(commits.map((c) => c.title)).toEqual(["fix the header"]);
  });
});

describe("a refused GitLab request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "secret upstream detail" }), { status: 403 })
      )
    );
  });

  it("names the status and not the body, for merge requests", async () => {
    await expect(fetchMergeRequests("https://gitlab.com", "g/p", "token")).rejects.toThrow(
      /^GitLab answered 403$/
    );
  });

  it("names the status and not the body, for branches and commits", async () => {
    await expect(fetchTaskBranches("https://gitlab.com", "g/p", "token", "GL-3")).rejects.toThrow(
      /^GitLab answered 403$/
    );
    await expect(fetchTaskCommits("https://gitlab.com", "g/p", "token", "GL-3")).rejects.toThrow(
      /^GitLab answered 403$/
    );
  });
});

// BP-869: release notes read merged requests by date, page after page
describe("fetchMergedRequests", () => {
  const mr = (iid: number) => ({ iid, title: `MR ${iid}`, state: "merged", web_url: `u${iid}`, merged_at: "2026-10-03T00:00:00Z", source_branch: "b", updated_at: "2026-10-03T00:00:00Z" });

  it("asks for merged requests updated since the day, and reads every page", async () => {
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => mr(i)))))
      .mockResolvedValueOnce(new Response(JSON.stringify([mr(100)])));
    const result = await fetchMergedRequests("https://gitlab.example.com/", "g/p", "tok", new Date("2026-10-01T00:00:00Z"));
    expect(result).toMatchObject({ complete: true });
    expect(result.requests).toHaveLength(101);
    expect(String(safeFetch.mock.calls[0][0])).toBe(
      "https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests?state=merged&updated_after=2026-10-01T00%3A00%3A00.000Z&per_page=100&page=1"
    );
  });

  it("stops at five full pages and says the list is not whole", async () => {
    safeFetch.mockReset();
    safeFetch.mockImplementation(async () => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => mr(i)))));
    const result = await fetchMergedRequests("https://gitlab.example.com", "g/p", "tok", new Date("2026-01-01"));
    expect(safeFetch).toHaveBeenCalledTimes(5);
    expect(result.complete).toBe(false);
  });
});

describe("checking a GitLab token before it is stored (BP-1109)", () => {
  const answer = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const paths = () => safeFetch.mock.calls.map(([url]) => new URL(String(url)).pathname + new URL(String(url)).search);

  beforeEach(() => safeFetch.mockReset());

  it("names whose token it is and its expiry, after reading each project and its merge requests", async () => {
    safeFetch
      .mockImplementationOnce(() => answer(200, { username: "gl-owner" }))
      .mockImplementationOnce(() => answer(200, { expires_at: "2027-01-24" }))
      .mockImplementation(() => answer(200, []));

    const checked = await checkGitlabToken("https://gitlab.example.com/", "glpat-x", ["group/app"]);

    expect(checked).toEqual({ ok: true, login: "gl-owner", expiresAt: new Date("2027-01-24T00:00:00Z") });
    expect(paths()).toEqual([
      "/api/v4/user",
      "/api/v4/personal_access_tokens/self",
      "/api/v4/projects/group%2Fapp",
      "/api/v4/projects/group%2Fapp/merge_requests?per_page=1",
    ]);
    expect(safeFetch.mock.calls[0][1].headers).toEqual({ "PRIVATE-TOKEN": "glpat-x" });
  });

  it("stores a token GitLab will not date, with no expiry known", async () => {
    safeFetch.mockImplementationOnce(() => answer(200, { username: "gl-owner" })).mockImplementationOnce(() => answer(404));

    expect(await checkGitlabToken("https://gitlab.example.com", "glpat-x", [])).toEqual({ ok: true, login: "gl-owner", expiresAt: null });
  });

  it.each([
    [[401], "GitLab rejected this token"],
    [[200, 404, 404], "cannot read group/app"],
    [[200, 404, 200, 403], "read_api scope"],
  ])("refuses %j with a reason a person can act on", async (statuses, reason) => {
    for (const status of statuses) safeFetch.mockImplementationOnce(() => answer(status, { username: "x" }));

    const checked = await checkGitlabToken("https://gitlab.example.com", "glpat-x", ["group/app"]);

    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toContain(reason);
    expect(!checked.ok && checked.error).toContain("Nothing was saved");
  });

  it("says GitLab could not be reached rather than blaming the token", async () => {
    safeFetch.mockImplementationOnce(() => Promise.reject(new Error("ENOTFOUND")));

    expect(await checkGitlabToken("https://gitlab.example.com", "glpat-x", [])).toEqual({
      ok: false,
      error: "GitLab could not be reached to check this token. Nothing was saved.",
    });
  });

  it.each([
    ["2027-01-24", "2027-01-24T00:00:00.000Z"],
    [null, null],
    ["", null],
    ["24/01/2027", null],
  ])("reads expires_at %j", (value, iso) => {
    expect(parseGitlabExpiry(value as string | null)?.toISOString() ?? null).toBe(iso);
  });
});
