import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { replaceProviderLinks } from "@/lib/pr-links";

/**
 * BP-429. This route is unchanged by that ticket; the tests are what it was missing. Its
 * transition is still keyed to the seeded column ids, so a board that renamed them opts out in
 * silence — asserted below rather than fixed, because which column merged work lands in is a
 * decision about the pipeline and not one to take while adding a missing argument to a matcher.
 * The network is stubbed; the matcher, the linking rule and the transition all run for real.
 */

// Hoisted: `@/lib/pr-links` above reaches `@/models/task`, so the factory below runs before a
// plain `const` in this scope is initialised (BP-559).
const { fetchPullRequests, projectFindById, taskFindOne, taskUpdateOne, logActivity } = vi.hoisted(
  () => ({
    fetchPullRequests: vi.fn(),
    projectFindById: vi.fn(),
    taskFindOne: vi.fn(),
    taskUpdateOne: vi.fn(),
    logActivity: vi.fn(),
  })
);

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, updateOne: taskUpdateOne } }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequests,
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1" } }),
}));

const { POST } = await import("./route");

const pr = (
  over: Partial<{
    number: number;
    ref: string;
    state: "open" | "closed";
    merged_at: string;
    sha: string;
  }> = {}
) => ({
  number: over.number ?? 1,
  title: "Some change",
  state: over.state ?? ("open" as const),
  html_url: `https://github.com/o/r/pull/${over.number ?? 1}`,
  merged_at: over.merged_at ?? null,
  head: { ref: over.ref ?? "bp-5/x", ...("sha" in over ? { sha: over.sha } : {}) },
  updated_at: "2026-08-01T00:00:00Z",
});

const RENAMED_COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#000", role: "backlog", order: 0 },
  { id: "building", label: "Building", color: "#000", role: "active", order: 1 },
  { id: "checking", label: "Checking", color: "#000", role: "review", order: 2 },
  { id: "verifying", label: "Verifying", color: "#000", role: "review", order: 3 },
  { id: "shipped", label: "Shipped", color: "#000", role: "done", order: 4 },
];

function project(over: Record<string, unknown> = {}) {
  return {
    _id: "p1",
    key: "BP",
    formerKeys: [],
    repositoryUrl: "https://github.com/o/r",
    githubToken: "enc",
    columns: null,
    ...over,
  };
}

function task(over: Record<string, unknown> = {}) {
  return { _id: "t1", taskNumber: 5, status: "in_review", linkedPRs: [], save: vi.fn(), ...over };
}

const request = () =>
  new Request("https://app.example.com/api/projects/p1/github/sync", { method: "POST" });
const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

beforeEach(() => {
  taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  vi.clearAllMocks();
  projectFindById.mockReturnValue({ lean: () => project() });
  taskFindOne.mockResolvedValue(task());
  fetchPullRequests.mockResolvedValue([]);
});

describe("POST .../github/sync", () => {
  it("still finds pull requests opened under a key the project has since left", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ formerKeys: ["CP"] }) });
    fetchPullRequests.mockResolvedValue([pr({ ref: "cp-5/old-prefix" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsFound).toBe(1);
    expect(body.tasksLinked).toBe(1);
    expect(body.prsLinked).toBe(1);
  });

  it("writes the links through the database, not by saving a mutated object", async () => {
    const doc = task();
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ number: 1 })]);

    await POST(request(), ctx());

    // The pipeline's *meaning* — which link survives — is asserted against a real database in
    // `e2e/pr-link-replacement.spec.ts`; what this file pins is that the route asks the database
    // to do it, rather than saving a copy it read a moment ago (BP-559)
    const [filter, update, options] = taskUpdateOne.mock.calls[0];
    // Mongoose refuses a pipeline update without it — the option is the whole reason the write
    // lives in `writeProviderLinks` rather than in this route
    expect(options).toEqual({ updatePipeline: true });
    expect(filter).toEqual({ _id: doc._id });
    expect(update).toEqual(replaceProviderLinks("github", [expect.objectContaining({ number: 1 })]));
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("names its own provider, which is what decides whose links are replaced", async () => {
    const doc = task();
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ number: 1 })]);

    await POST(request(), ctx());

    expect(taskUpdateOne.mock.calls[0][1]).toEqual(replaceProviderLinks("github", [
      expect.objectContaining({ provider: "github", number: 1 }),
    ]));
  });

  it("moves a merged task out of review, and records where it went", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    // The move is a guarded write now, so what proves it is what the database was asked for
    expect(taskUpdateOne).toHaveBeenCalledWith(
      { _id: doc._id, status: "in_review" },
      { $set: { status: "ready_to_test" } }
    );
    expect(body.autoTransitioned).toBe(1);
    expect(logActivity).toHaveBeenCalledWith(
      "t1",
      "u1",
      "status_changed",
      "status",
      "in_review",
      "ready_to_test"
    );
  });

  it("leaves a task a human was asked to look at where it is", async () => {
    const doc = task({ status: "needs_human_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("needs_human_review");
    expect(logActivity).not.toHaveBeenCalled();
    // The control: the route ran and did its other work, so the silence above is a decision
    // rather than a sync that never reached this task.
    expect(body.prsLinked).toBe(1);
  });

  it("moves nothing when nothing is merged", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ state: "open" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("in_review");
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });

  it("transitions nothing on a board that renamed its columns — the known gap, pinned", async () => {
    // BP-110 made GitLab's transition role-based and left this one keyed to the seeded ids, so a
    // renamed board gets a sync that reports success and moves nothing. Asserted so that whoever
    // closes it has to come here and say so, instead of finding a test that agrees either way.
    projectFindById.mockReturnValue({ lean: () => project({ columns: RENAMED_COLUMNS }) });
    const doc = task({ status: "checking" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("checking");
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });

  /**
   * The whole point of guarding the write: two overlapping syncs both read `in_review`, and
   * without the precondition both wrote the move and both logged it — one transition, two rows in
   * the task's history (BP-559).
   */
  it("logs nothing when another sync moved the task first", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);
    // The links land; the status write finds the task already moved
    taskUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });

    const body = await (await POST(request(), ctx())).json();

    expect(body.autoTransitioned).toBe(0);
    expect(logActivity).not.toHaveBeenCalledWith(
      "t1",
      "u1",
      "status_changed",
      "status",
      "in_review",
      "ready_to_test"
    );
  });

  /**
   * BP-443. The state a badge shows comes from here, and `withChecks` runs for real in this file —
   * only `fetchPullRequests` is replaced — so what is stubbed below is the network itself.
   */
  describe("what CI said", () => {
    // `clearAllMocks` does not put a global back, and the tests above this block reach no network
    // only because their fixtures carry no head commit — a leaked `fetch` would make that luck
    afterEach(() => vi.unstubAllGlobals());

    const checkRuns = (runs: unknown[]) => ({ check_runs: runs });
    const noStatuses = { state: "pending", statuses: [] };

    /** Answers the two commit endpoints and records every URL asked for. */
    function githubAnswers(answer: (url: string) => unknown | undefined) {
      const asked: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          asked.push(String(url));
          const body = answer(String(url));
          if (body === undefined) return new Response("no", { status: 500 });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        })
      );
      return asked;
    }

    /** The documents the pipeline update appends — `replaceProviderLinks`'s `$literal` half. */
    const linkWritten = (): Record<string, unknown>[] => {
      const [stage] = taskUpdateOne.mock.calls[0][1] as {
        $set: { linkedPRs: { $concatArrays: [unknown, { $literal: Record<string, unknown>[] }] } };
      }[];
      return stage.$set.linkedPRs.$concatArrays[1].$literal;
    };

    it("stores the state the checks reduce to, and the check that decided it", async () => {
      githubAnswers((url) =>
        url.includes("/check-runs")
          ? checkRuns([{ name: "e2e", status: "completed", conclusion: "failure" }])
          : noStatuses
      );
      fetchPullRequests.mockResolvedValue([pr({ sha: "abc123" })]);

      await POST(request(), ctx());

      expect(linkWritten()[0]).toMatchObject({ ci: "failure", ciLabel: "e2e" });
    });

    // The head commit is what checks hang off, so losing it loses every future refresh
    it("stores the head commit it asked about", async () => {
      githubAnswers((url) => (url.includes("/check-runs") ? checkRuns([]) : noStatuses));
      fetchPullRequests.mockResolvedValue([pr({ sha: "abc123" })]);

      await POST(request(), ctx());

      expect(linkWritten()[0]).toMatchObject({ headSha: "abc123" });
    });

    // Both halves of the rate-limit answer in one assertion: a finished pull request is not asked
    // about, which is also what "stop polling merged/closed" means here
    it("never asks about a pull request that is already merged", async () => {
      const asked = githubAnswers(() => noStatuses);
      fetchPullRequests.mockResolvedValue([
        pr({ number: 1, sha: "abc123", merged_at: "2026-08-02T00:00:00Z" }),
      ]);

      await POST(request(), ctx());

      expect(asked.filter((url) => url.includes("/commits/"))).toEqual([]);
      expect(linkWritten()[0]).toMatchObject({ state: "merged", ci: "none" });
    });

    /**
     * The graceful fallback. A pull request whose checks could not be read still has a number, a
     * title and a merge state worth showing, so the sync must not take those down with it — and
     * `unknown` rather than `none`, because "we could not ask" and "nothing ran" send a reader to
     * different places.
     */
    it("stores the pull request anyway when GitHub will not answer about its checks", async () => {
      githubAnswers(() => undefined);
      fetchPullRequests.mockResolvedValue([pr({ sha: "abc123" })]);

      const body = await (await POST(request(), ctx())).json();

      expect(body.prsLinked).toBe(1);
      expect(linkWritten()[0]).toMatchObject({
        number: 1,
        title: "Some change",
        ci: "unknown",
        ciLabel: null,
      });
    });

    // An open pull request GitHub answered without a head commit cannot be asked about either
    it("says unknown rather than none when there is no commit to ask about", async () => {
      const asked = githubAnswers(() => noStatuses);
      fetchPullRequests.mockResolvedValue([pr({})]);

      await POST(request(), ctx());

      expect(asked.filter((url) => url.includes("/commits/"))).toEqual([]);
      expect(linkWritten()[0]).toMatchObject({ ci: "unknown", headSha: null });
    });
  });

  /**
   * `fetchPullRequests` throws on every non-ok answer from GitHub. Uncaught, that is a 500 whose
   * body is not JSON, and the client then falls back to `res.statusText` — which under HTTP/2 is
   * empty by definition. On Railway that was a red toast with no words in it.
   */
  describe("when GitHub cannot be reached at all", () => {
    it("answers 502 with something a person can read", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      fetchPullRequests.mockRejectedValue(new Error("GitHub answered 401"));

      const res = await POST(request(), ctx());
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toContain("401");
      expect(String(body.error).length).toBeGreaterThan(10);
    });

    it("writes nothing when it could not read anything", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      fetchPullRequests.mockRejectedValue(new Error("GitHub answered 403"));

      await POST(request(), ctx());

      expect(taskUpdateOne).not.toHaveBeenCalled();
    });
  });
});
