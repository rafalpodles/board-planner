import { describe, it, expect, vi } from "vitest";
import {
  allowLoopbackIn,
  checkGithubToken,
  fetchDeployments,
  fetchDeploymentStatuses,
  fetchMergedPullRequests, fetchPullRequests,
  GitHubRateLimited,
  GitHubRefused,
  matchPRsToTasks,
  parseTokenExpiry,
  reduceChecks,
} from "./github";

/**
 * BP-472 found `coda.ts` calling `safeFetch` with no `DestinationOptions` at all — a silent
 * refusal of `127.0.0.1` in every environment, because `allowLoopback` defaults to false — and
 * fixed it by mirroring this file's own `GITHUB_DESTINATION`. Nothing pinned that GITHUB_DESTINATION
 * itself stays wired to `safeFetch`, so the same regression could land here with no test to catch it.
 */
// vi.hoisted, not a plain top-level const: this file (unlike coda.test.ts) statically imports
// "./github" above, so without it the mock factory below — itself hoisted above every import —
// would run before this assignment and throw a TDZ error
const safeFetch = vi.hoisted(() =>
  vi.fn((_url: string, _init?: RequestInit, _options?: { allowLoopback?: boolean }) =>
    Promise.resolve(new Response(JSON.stringify([])))
  )
);
vi.mock("./safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-fetch")>()),
  safeFetch,
}));

describe("the loopback carve-out that lets e2e/github-stub.mjs be reached", () => {
  it("passes a DestinationOptions that allows loopback outside production", async () => {
    await fetchPullRequests("owner", "repo", "tok");

    expect(safeFetch).toHaveBeenCalled();
    // vitest itself runs with NODE_ENV=test, so this is the same "not production" case the e2e
    // stub relies on — asserting the concrete value, not just that some object was passed
    for (const call of safeFetch.mock.calls) {
      expect(call[2]).toEqual({ allowLoopback: true });
    }
  });

  // Pins allowLoopbackIn's own logic directly, rather than only through GITHUB_DESTINATION's
  // module-load-time snapshot of it
  it("refuses loopback in production", () => {
    expect(allowLoopbackIn("production")).toBe(false);
    expect(allowLoopbackIn("test")).toBe(true);
  });
});

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
    expect(matched.map((m) => [m.number, ...m.matchedTaskNumbers])).toEqual([[1, 250], [2, 9]]);
  });

  it("still matches pull requests opened under a key the project has since left", () => {
    const matched = matchPRsToTasks([pr({ ref: "cp-250/field-activity-history" })], "BP", ["CP"]);
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([250]);
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
    expect(matched.flatMap((m) => m.matchedTaskNumbers).sort()).toEqual([1, 2, 3]);
  });

  it("does not match a project it never was", () => {
    expect(matchPRsToTasks([pr({ ref: "zz-7/other" })], "BP", ["CP"])).toEqual([]);
  });

  // Keys are not format-validated, so one containing regex syntax must not widen the match
  it("treats a key with regex characters literally", () => {
    expect(matchPRsToTasks([pr({ ref: "cX-5/x" })], "C(", ["C."])).toEqual([]);
    expect(matchPRsToTasks([pr({ ref: "c(-5/x" })], "C(")).toHaveLength(1);
  });

  // BP-611. `websubp-99` contains `bp-99`, and a link to the wrong task is one a later sync would
  // have to contradict.
  it("does not find the key inside a longer word", () => {
    const matched = matchPRsToTasks(
      [pr({ ref: "feat/websubp-99", title: "BP-5 real work" })],
      "BP"
    );
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([5]);
  });

  // BP-635. Branch `bp-628/…`, title listing four keys: the real shape of PR #391, which linked
  // one task of the four.
  it("links every key in the title even when the branch already names one", () => {
    const [matched] = matchPRsToTasks(
      [pr({ ref: "bp-628/a-link-change-leaves-a-trace", title: "fix: a round (BP-628, BP-631, BP-632, BP-634)" })],
      "BP"
    );
    expect(matched.matchedTaskNumbers).toEqual([628, 631, 632, 634]);
  });

  it("keeps the branch's key when the title names only another", () => {
    const [matched] = matchPRsToTasks([pr({ ref: "bp-5/x", title: "BP-6 retitled" })], "BP");
    expect(matched.matchedTaskNumbers).toEqual([5, 6]);
  });

  it("reads every key of a title when the branch has none", () => {
    const [matched] = matchPRsToTasks([pr({ ref: "family/tidy", title: "BP-8, bp-9 and BP 10" })], "BP");
    expect(matched.matchedTaskNumbers).toEqual([8, 9, 10]);
  });

  it("names a task once, however many times and under whichever key", () => {
    const [matched] = matchPRsToTasks([pr({ ref: "bp-5/x", title: "BP-5 and CP-5, then bp-5" })], "BP", ["CP"]);
    expect(matched.matchedTaskNumbers).toEqual([5]);
  });

  it("holds the boundary for every key it reads, not only the first", () => {
    const [matched] = matchPRsToTasks([pr({ ref: "bp-5/x", title: "BP-5 bumps websubp-99" })], "BP");
    expect(matched.matchedTaskNumbers).toEqual([5]);
  });

  it("still matches the key after a separator, which is every branch anyone writes", () => {
    const matched = matchPRsToTasks(
      [
        pr({ number: 1, ref: "feat/bp-7/slug" }),
        pr({ number: 2, ref: "x", title: "BP-8 at the front" }),
        pr({ number: 3, ref: "x", title: "fixes BP-9 mid-sentence" }),
        pr({ number: 4, ref: "bp 10/spaced" }),
      ],
      "BP"
    );
    expect(matched.flatMap((m) => m.matchedTaskNumbers)).toEqual([7, 8, 9, 10]);
  });

  it("holds the boundary against a former key too", () => {
    expect(matchPRsToTasks([pr({ ref: "websucp-3/x" })], "BP", ["CP"])).toEqual([]);
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

describe("deployments and the rate limit they can hit (BP-878)", () => {
  const refused = (headers: Record<string, string>) =>
    safeFetch.mockResolvedValueOnce(new Response("{}", { status: 403, headers }));

  it("asks for one environment, a page at a time, and a deployment's statuses", async () => {
    safeFetch.mockClear();
    await fetchDeployments("o", "r", "tok", "production", 2);
    await fetchDeploymentStatuses("o", "r", "tok", 7);

    expect(safeFetch.mock.calls[0][0]).toMatch(/\/repos\/o\/r\/deployments\?environment=production&per_page=100&page=2$/);
    expect(safeFetch.mock.calls[1][0]).toMatch(/\/repos\/o\/r\/deployments\/7\/statuses\?per_page=30$/);
  });

  it("a primary limit says when it resets", async () => {
    refused({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789000000" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const err = await fetchDeployments("o", "r", "tok", "production", 1).catch((e) => e);

    expect(err).toBeInstanceOf(GitHubRateLimited);
    expect(err.until).toEqual(new Date(1789000000 * 1000));
  });

  it("a secondary limit waits as long as retry-after says", async () => {
    refused({ "retry-after": "120" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = Date.now();

    const err = await fetchDeployments("o", "r", "tok", "production", 1).catch((e) => e);

    expect(err).toBeInstanceOf(GitHubRateLimited);
    expect(err.until.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(err.until.getTime()).toBeLessThan(before + 125_000);
  });

  it("any other refusal is an ordinary error", async () => {
    refused({ "x-ratelimit-remaining": "4999" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const err = await fetchDeployments("o", "r", "tok", "production", 1).catch((e) => e);

    expect(err).not.toBeInstanceOf(GitHubRateLimited);
    expect(err).toBeInstanceOf(GitHubRefused);
    expect(err.message).toBe("GitHub answered 403");
  });
});

// BP-869: release notes need every merge of a window, not the latest few the activity listing holds
describe("fetchMergedPullRequests", () => {
  const item = (n: number) => ({ title: `PR ${n}`, html_url: `https://github.com/o/r/pull/${n}`, pull_request: { merged_at: "2026-10-03T00:00:00Z" } });

  it("searches merged pull requests by the days of the window, page after page, and says when it read them all", async () => {
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 101, items: Array.from({ length: 100 }, (_, i) => item(i + 1)) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 101, items: [item(101), { title: "unmerged", html_url: "x", pull_request: { merged_at: null } }] })));
    const result = await fetchMergedPullRequests("o", "r", "tok", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-14T23:59:59Z"));
    expect(result.pulls).toHaveLength(101);
    expect(result.complete).toBe(true);
    const first = decodeURIComponent(String(safeFetch.mock.calls[0][0]));
    expect(first).toContain("/search/issues?q=repo:o/r is:pr is:merged merged:2026-10-01..2026-10-14&per_page=100&page=1");
    expect(String(safeFetch.mock.calls[1][0])).toContain("page=2");
  });

  it("says the list is not whole when GitHub's search timed out", async () => {
    safeFetch.mockReset();
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 1, incomplete_results: true, items: [item(1)] })));
    expect((await fetchMergedPullRequests("o", "r", "tok", new Date("2026-10-01"), new Date("2026-10-02"))).complete).toBe(false);
  });

  it("stops at five pages and says the list is not whole", async () => {
    safeFetch.mockReset();
    safeFetch.mockImplementation(async () => new Response(JSON.stringify({ total_count: 900, items: Array.from({ length: 100 }, (_, i) => item(i)) })));
    const result = await fetchMergedPullRequests("o", "r", "tok", new Date("2026-01-01"), new Date("2026-12-31"));
    expect(safeFetch).toHaveBeenCalledTimes(5);
    expect(result.complete).toBe(false);
  });
});

describe("checking a token before it is stored (BP-1108)", () => {
  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
  const paths = () => safeFetch.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search);

  it("names whose token it is and when it expires, after reading each repository's pull requests", async () => {
    safeFetch.mockReset();
    safeFetch
      .mockImplementationOnce(() => answer(200, { login: "rafalpodles" }, { "github-authentication-token-expiration": "2027-01-24 10:00:00 +0100" }))
      .mockImplementation(() => answer(200, []));

    const checked = await checkGithubToken("tok", [{ owner: "o", repo: "r" }]);

    expect(checked).toEqual({ ok: true, login: "rafalpodles", expiresAt: new Date("2027-01-24T09:00:00Z") });
    expect(paths()).toEqual(["/user", "/repos/o/r", "/repos/o/r/pulls?state=open&per_page=1"]);
  });

  it.each([
    [[401], "GitHub rejected this token"],
    [[200, 404], "cannot read o/r"],
    [[200, 200, 403], "not its pull requests"],
  ])("refuses %j with a reason a person can act on", async (statuses, reason) => {
    safeFetch.mockReset();
    for (const status of statuses) safeFetch.mockImplementationOnce(() => answer(status, { login: "x" }));

    const checked = await checkGithubToken("tok", [{ owner: "o", repo: "r" }]);

    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toContain(reason);
    expect(!checked.ok && checked.error).toContain("Nothing was saved");
  });

  it("says GitHub could not be reached rather than blaming the token", async () => {
    safeFetch.mockReset();
    safeFetch.mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")));

    expect(await checkGithubToken("tok", [])).toEqual({ ok: false, error: "GitHub could not be reached to check this token. Nothing was saved." });
  });
});

describe("GitHub's token expiry header", () => {
  it.each([
    ["2027-01-24 10:00:00 +0100", "2027-01-24T09:00:00.000Z"],
    ["2027-01-24 10:00:00 UTC", "2027-01-24T10:00:00.000Z"],
    ["2027-01-24 10:00:00 -05:30", "2027-01-24T15:30:00.000Z"],
  ])("reads %s", (header, iso) => {
    expect(parseTokenExpiry(header)?.toISOString()).toBe(iso);
  });

  it.each([null, "", "never", "2027-13-45 99:00:00 +0100"])("reads %j as no expiry", (header) => {
    expect(parseTokenExpiry(header as string | null)).toBeNull();
  });
});
