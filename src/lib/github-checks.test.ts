import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  MAX_CHECKED_PULL_REQUESTS,
  fetchChecks,
  fetchPullRequests,
  withChecks,
  type ParsedPR,
} from "./github";

/**
 * BP-443 review. The cap, its ordering and the batching are what the "safe to leave the background
 * sync on" argument rests on, and no fixture anywhere had more than two open pull requests — so
 * removing the cap, reversing the sort or unbounding the fan-out reddened nothing.
 */

const pr = (over: Partial<ParsedPR> = {}): ParsedPR => ({
  number: 1,
  title: "Some change",
  state: "open",
  url: "https://github.com/o/r/pull/1",
  mergedAt: null,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  matchedTaskNumber: 5,
  headSha: "sha1",
  ...over,
});

/** Answers every commit endpoint, recording what was asked and how many were in flight at once. */
function githubCounting(answer: (url: string) => unknown = () => ({ check_runs: [] })) {
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(String(url));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      const body = String(url).includes("/check-runs")
        ? answer(String(url))
        : { state: "pending", statuses: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return { asked, peak: () => peak };
}

/** The `page` parameter, parsed — `includes("page=1")` also matches `per_page=100&page=2`. */
const pageOf = (url: string) => Number(new URL(url).searchParams.get("page") ?? 1);

const shasAsked = (asked: string[]) =>
  asked
    .filter((url) => url.includes("/check-runs"))
    .map((url) => /\/commits\/([^/]+)\//.exec(url)?.[1] as string);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("how many pull requests one sync asks about", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      pr({
        number: i + 1,
        headSha: `sha${i + 1}`,
        // Ascending, so the freshest are at the end and a cap that did not sort would keep the wrong ones
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000),
      })
    );

  it("stops at the cap", async () => {
    const { asked } = githubCounting();

    await withChecks(many(MAX_CHECKED_PULL_REQUESTS + 5), "o", "r", "t");

    expect(shasAsked(asked)).toHaveLength(MAX_CHECKED_PULL_REQUESTS);
  });

  // The doc comment's claim, which is what makes the cap defensible rather than arbitrary
  it("asks about the most recently updated, and drops the stalest", async () => {
    const { asked } = githubCounting();
    const prs = many(MAX_CHECKED_PULL_REQUESTS + 3);

    await withChecks(prs, "o", "r", "t");

    const asked_ = new Set(shasAsked(asked));
    // The three oldest are numbers 1, 2 and 3
    expect([...asked_]).not.toContain("sha1");
    expect([...asked_]).not.toContain("sha3");
    expect(asked_.has(`sha${prs.length}`), "the freshest was asked about").toBe(true);
  });

  it("keeps every pull request, asked about or not", async () => {
    githubCounting();
    const prs = many(MAX_CHECKED_PULL_REQUESTS + 5);

    const out = await withChecks(prs, "o", "r", "t");

    expect(out).toHaveLength(prs.length);
    expect(out.filter((p) => p.ci === "unknown")).toHaveLength(5);
  });

  // Unbounded, this is a fan-out at somebody else's API
  it("does not ask about them all at once", async () => {
    const counting = githubCounting();

    await withChecks(many(MAX_CHECKED_PULL_REQUESTS), "o", "r", "t");

    // Two requests per pull request, so a batch of five is ten in flight
    expect(counting.peak()).toBeLessThanOrEqual(10);
  });

  it("asks about nothing at all when every pull request has finished", async () => {
    const { asked } = githubCounting();

    await withChecks(
      many(5).map((p) => ({ ...p, state: "merged" as const })),
      "o",
      "r",
      "t"
    );

    expect(shasAsked(asked)).toEqual([]);
  });
});

/**
 * A matrix build puts more than a hundred runs on one commit, and a page is not ordered by
 * outcome — so reading only the first would report a pass while the failure sat on page two.
 */
describe("a commit with more check runs than one page holds", () => {
  const page = (name: string, conclusion: string, count: number) =>
    Array.from({ length: count }, () => ({ name, status: "completed", conclusion }));

  it("reads past the first page to find the failure", async () => {
    githubCounting((url) =>
      pageOf(url) === 1
        ? { total_count: 120, check_runs: page("shard", "success", 100) }
        : { total_count: 120, check_runs: page("the-one-that-failed", "failure", 20) }
    );

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({
      ci: "failure",
      ciLabel: "the-one-that-failed",
    });
  });

  // The control: a commit that fits in one page is read once, not three times
  it("stops as soon as the page is not full", async () => {
    const { asked } = githubCounting(() => ({
      total_count: 2,
      check_runs: page("unit", "success", 2),
    }));

    await fetchChecks("o", "r", "sha1", "t");

    expect(asked.filter((url) => url.includes("/check-runs"))).toHaveLength(1);
  });
});

/**
 * The two mechanisms are independent, and a repository using only one gets an error from the
 * other. `Promise.all` threw the good half away with the bad and answered `unknown` for a commit
 * whose checks had been read perfectly well.
 */
describe("when only one of the two answers", () => {
  function answering(check: "ok" | "fail", status: "ok" | "fail") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const which = String(url).includes("/check-runs") ? check : status;
        if (which === "fail") return new Response("no", { status: 500 });
        return new Response(
          JSON.stringify(
            String(url).includes("/check-runs")
              ? { check_runs: [{ name: "unit", status: "completed", conclusion: "failure" }] }
              : { state: "success", statuses: [{ context: "ci/other", state: "success" }] }
          ),
          { status: 200 }
        );
      })
    );
  }

  it("still reports the check runs when the commit status call fails", async () => {
    answering("ok", "fail");

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({ ci: "failure", ciLabel: "unit" });
  });

  it("still reports the commit status when the check-runs call fails", async () => {
    answering("fail", "ok");

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({
      ci: "success",
      ciLabel: "ci/other",
    });
  });

  // Only when neither answered is there genuinely nothing to say
  it("says unknown when neither answers", async () => {
    answering("fail", "fail");

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({ ci: "unknown", ciLabel: null });
  });

  /**
   * The door `allSettled` opened while closing another. When the half that answered is **empty**
   * and the half that failed is the one that might have had something, `none` is a claim with no
   * evidence — and a worse one than `unknown`, because "nothing has run" reads as a fact. A green
   * tick became a plain open badge, and the sync reported success.
   *
   * Not a hypothetical: a repository on external CI posts commit statuses and no check runs, so the
   * empty survivor is the ordinary shape for exactly the repositories the second mechanism exists
   * for.
   */
  it("does not call it 'nothing has run' when it only asked half the question", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/check-runs")
          ? new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 })
          : new Response("no", { status: 500 })
      )
    );

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({ ci: "unknown", ciLabel: null });
  });

  // The mirror: check runs refused, and the commit status answers what GitHub returns for a commit
  // nothing has posted about at all
  it("does not read an empty pending status as proof when check runs failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/check-runs")
          ? new Response("no", { status: 500 })
          : new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 })
      )
    );

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({ ci: "unknown", ciLabel: null });
  });

  // The control, and the reason this is not simply "any rejection means unknown": a survivor that
  // actually said something is still worth reading
  it("still trusts a survivor that had an answer", async () => {
    answering("ok", "fail");

    expect(await fetchChecks("o", "r", "sha1", "t")).toEqual({ ci: "failure", ciLabel: "unit" });
  });
});

/**
 * A rate limit is the one refusal where the answer is to wait rather than to check the token, so
 * it says so. And GitHub's own body never travels in the message: the host is whatever
 * GITHUB_API_BASE_URL names, it is handed an Authorization header, and a server that echoes its
 * request would otherwise put the project's token in a toast.
 */
describe("what a refusal says", () => {
  function refusing(status: number, headers: Record<string, string>, body: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status, headers }))
    );
  }

  it("names a rate limit rather than reporting a bare 403", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusing(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789000000" }, "{}");

    await expect(fetchPullRequests("o", "r", "t")).rejects.toThrow(/rate limit/i);
  });

  it("reports an ordinary refusal by its status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusing(401, {}, "{}");

    await expect(fetchPullRequests("o", "r", "t")).rejects.toThrow("GitHub answered 401");
  });

  it("never carries what the other end said into the message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusing(401, {}, JSON.stringify({ echoed: "Bearer the-projects-secret-token" }));

    await expect(fetchPullRequests("o", "r", "t")).rejects.not.toThrow(/secret-token/);
  });
});
