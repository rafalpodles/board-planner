import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { MAX_CHECKED_PULL_REQUESTS, fetchChecks, withChecks, type ParsedPR } from "./github";

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
