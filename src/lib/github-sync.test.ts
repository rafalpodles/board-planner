import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * BP-443. The sync moved out of its route so a background tick could run the same code, and the
 * one thing that separates the two callers is asserted here: a tick has nobody to name, so it
 * refreshes what the badges show and moves no task between columns.
 */

const { fetchPullRequests, projectFind, taskFindOne, taskUpdateOne, logActivity } = vi.hoisted(
  () => ({
    fetchPullRequests: vi.fn(),
    projectFind: vi.fn(),
    taskFindOne: vi.fn(),
    taskUpdateOne: vi.fn(),
    logActivity: vi.fn(),
  })
);

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, updateOne: taskUpdateOne } }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequests,
}));

const { syncGithubPullRequests, githubSyncTick, syncTickMs } = await import("./github-sync");

const project = (over: Record<string, unknown> = {}) => ({
  _id: "p1",
  key: "BP",
  formerKeys: [],
  repositoryUrl: "https://github.com/o/r",
  githubToken: "enc",
  columns: null,
  ...over,
});

const openPR = {
  number: 1,
  title: "Some change",
  state: "open" as const,
  html_url: "https://github.com/o/r/pull/1",
  merged_at: null,
  head: { ref: "bp-5/x", sha: "abc123" },
  updated_at: "2026-08-01T00:00:00Z",
};

const mergedPR = {
  number: 1,
  title: "Some change",
  state: "closed" as const,
  html_url: "https://github.com/o/r/pull/1",
  merged_at: "2026-08-02T00:00:00Z",
  head: { ref: "bp-5/x" },
  updated_at: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "in_review" });
  fetchPullRequests.mockResolvedValue([mergedPR]);
  projectFind.mockReturnValue({ lean: () => Promise.resolve([project()]) });
});

afterEach(() => vi.unstubAllGlobals());

describe("who asked, and what that earns", () => {
  it("moves a merged task out of review when a person asked", async () => {
    const result = await syncGithubPullRequests(project(), "u1");

    expect(result).toMatchObject({ ok: true, autoTransitioned: 1 });
    expect(logActivity).toHaveBeenCalledWith(
      "t1",
      "u1",
      "status_changed",
      "status",
      "in_review",
      "ready_to_test"
    );
  });

  /**
   * The reason the background tick exists in this shape. A column change has an author in the
   * task's history, and a tick has no person to put there — so it refreshes the links and leaves
   * the pipeline to somebody who can be asked about it.
   */
  it("moves nothing, and records nothing, when nobody asked", async () => {
    const result = await syncGithubPullRequests(project(), null);

    expect(result).toMatchObject({ ok: true, autoTransitioned: 0 });
    expect(logActivity).not.toHaveBeenCalled();
    // The status write is the one that must not happen; the link write still must
    expect(taskUpdateOne).toHaveBeenCalledTimes(1);
    expect(taskUpdateOne.mock.calls[0][0]).toEqual({ _id: "t1" });
    // The control: the sync ran, so the silence above is the rule rather than an empty fetch
    expect(result).toMatchObject({ prsLinked: 1 });
  });
});

describe("what the sync refuses before it reaches the network", () => {
  it("refuses a project with no token", async () => {
    expect(await syncGithubPullRequests(project({ githubToken: "" }), "u1")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(fetchPullRequests).not.toHaveBeenCalled();
  });

  it("refuses a repository that is not GitHub's", async () => {
    const result = await syncGithubPullRequests(
      project({ repositoryUrl: "https://gitlab.com/o/r" }),
      "u1"
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(fetchPullRequests).not.toHaveBeenCalled();
  });
});

describe("the background tick", () => {
  it("asks only about projects that have a token to ask with", async () => {
    await githubSyncTick();

    expect(projectFind.mock.calls[0][0]).toEqual({ githubToken: { $nin: [null, ""] } });
  });

  // One unreachable repository must not cost every other board its refresh
  it("keeps going after a project GitHub will not answer about", async () => {
    projectFind.mockReturnValue({
      lean: () => Promise.resolve([project({ _id: "p1", key: "AA" }), project({ _id: "p2", key: "BB" })]),
    });
    fetchPullRequests.mockRejectedValueOnce(new Error("502 from GitHub"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await githubSyncTick();

    expect(fetchPullRequests).toHaveBeenCalledTimes(2);
  });
});

/**
 * `withChecks` answers `unknown` for an open pull request it did not ask about — past the cap, or
 * because the request failed — and `writeProviderLinks` replaces the whole array. Without carrying
 * the stored answer forward, a board with more than twenty open pull requests starves the same
 * ones on every tick and their badges read "?" for ever; one transient 502 does it to a single
 * badge.
 */
describe("an answer this sync could not get", () => {
  const linkWritten = (): Record<string, unknown>[] => {
    const [stage] = taskUpdateOne.mock.calls[0][1] as {
      $set: { linkedPRs: { $concatArrays: [unknown, { $literal: Record<string, unknown>[] }] } };
    }[];
    return stage.$set.linkedPRs.$concatArrays[1].$literal;
  };

  /** The checks call fails, so `fetchChecks` answers `unknown`. */
  function githubRefusesChecks() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/commits/")
          ? new Response("no", { status: 500 })
          : new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 })
      )
    );
  }

  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([openPR]);
    githubRefusesChecks();
  });

  it("keeps what the last sync learned about the same commit", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [{ provider: "github", number: 1, ci: "success", ciLabel: "e2e", headSha: "abc123" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "success", ciLabel: "e2e", headSha: "abc123" });
  });

  // A different commit makes the old answer an answer about something else
  it("does not carry an answer forward onto a new commit", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [{ provider: "github", number: 1, ci: "success", ciLabel: "e2e", headSha: "older" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown", ciLabel: null });
  });

  /**
   * `running` is not a state worth keeping. A pull request past the cap is never asked about again,
   * and GitHub does not touch a pull request's `updated_at` when a check run finishes — checks hang
   * off the commit — so a carried `running` would pulse "e2e running" for ever on a branch whose
   * build ended an hour ago.
   */
  it("does not pin a build that was merely running when we last looked", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [{ provider: "github", number: 1, ci: "running", ciLabel: "e2e", headSha: "abc123" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown", ciLabel: null });
  });

  // The finished ones are kept, which is the whole point of carrying anything forward
  it("keeps the states that were finished when we last looked", async () => {
    for (const ci of ["success", "failure", "none"]) {
      vi.clearAllMocks();
      taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
      githubRefusesChecks();
      taskFindOne.mockResolvedValue({
        _id: "t1",
        taskNumber: 5,
        status: "todo",
        linkedPRs: [{ provider: "github", number: 1, ci, ciLabel: "e2e", headSha: "abc123" }],
      });

      await syncGithubPullRequests(project(), "u1");

      expect(linkWritten()[0], ci).toMatchObject({ ci });
    }
  });

  it("says unknown when there was never an answer to keep", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown" });
  });

  // The control: a sync that CAN ask overwrites the stored answer, which is the whole point of it
  it("still replaces a stored answer when GitHub does answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("/check-runs")
              ? { check_runs: [{ name: "unit", status: "completed", conclusion: "failure" }] }
              : { state: "pending", statuses: [] }
          ),
          { status: 200 }
        )
      )
    );
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [{ provider: "github", number: 1, ci: "success", ciLabel: "e2e", headSha: "abc123" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "failure", ciLabel: "unit" });
  });
});

describe("which task a refresh may move", () => {
  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([mergedPR]);
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "in_review", linkedPRs: [] });
  });

  it("moves the task the person is looking at", async () => {
    expect(await syncGithubPullRequests(project(), "u1", 5)).toMatchObject({ autoTransitioned: 1 });
  });

  // The button says "Refresh PR status"; moving somebody else's task under your name is not that
  it("leaves every other task where it is", async () => {
    const result = await syncGithubPullRequests(project(), "u1", 999);

    expect(result).toMatchObject({ autoTransitioned: 0, prsLinked: 1 });
    expect(logActivity).not.toHaveBeenCalled();
  });

  // Project settings' own Sync sends no task number and keeps the behaviour it always had
  it("moves every eligible task when no task is named", async () => {
    expect(await syncGithubPullRequests(project(), "u1")).toMatchObject({ autoTransitioned: 1 });
  });
});

/**
 * A board that renamed its columns opts out of the transition, which BP-429 pinned — except the
 * fixture it used sat in a renamed column, so `task.status === "in_review"` refused first and the
 * destination guard was never reached. This is the same task IN review on a board with no
 * `ready_to_test`, which is the only shape that reaches it.
 */
describe("a board with nowhere to move the task to", () => {
  it("transitions nothing when the destination column does not exist", async () => {
    fetchPullRequests.mockResolvedValue([mergedPR]);
    projectFind.mockReturnValue({ lean: () => Promise.resolve([project()]) });
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "in_review", linkedPRs: [] });

    const withoutTheColumn = project({
      columns: [
        { id: "todo", label: "To do", color: "#000", role: "backlog", order: 0 },
        { id: "in_review", label: "In review", color: "#000", role: "review", order: 1 },
        { id: "shipped", label: "Shipped", color: "#000", role: "done", order: 2 },
      ],
    });

    const result = await syncGithubPullRequests(withoutTheColumn, "u1");

    expect(result).toMatchObject({ autoTransitioned: 0, prsLinked: 1 });
    expect(logActivity).not.toHaveBeenCalled();
  });
});

/**
 * CLAUDE.md documents `0` as the operator's off switch. A value that is not a number used to read
 * as NaN and silently never start, which is indistinguishable from a sync that is working.
 */
describe("how often the background sync runs", () => {
  it("defaults when unset", () => {
    expect(syncTickMs(undefined)).toBe(300000);
    expect(syncTickMs("")).toBe(300000);
  });

  it("takes a number of milliseconds", () => {
    expect(syncTickMs("600000")).toBe(600000);
  });

  it("is off at zero, which is the documented switch", () => {
    expect(syncTickMs("0")).toBe(0);
  });

  it("falls back loudly rather than silently never starting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(syncTickMs("5m")).toBe(300000);
    expect(syncTickMs("-1")).toBe(300000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // This spends somebody else's rate limit; a fumbled 50 would burn a token's hour in an afternoon
  it("will not go below a minute", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(syncTickMs("50")).toBe(60000);
  });
});

/**
 * `taskSchema` has `timestamps: true`, and Mongoose appends `$set: { updatedAt: now }` to a
 * pipeline update. An unconditional write therefore moved every task with a pull request to "just
 * now" every five minutes — and the dashboard reads `updatedAt` on a done task as the date it was
 * finished, so work closed weeks ago reported as finished this week for as long as its merged pull
 * request stayed in GitHub's recently-closed window.
 */
describe("a sync that learned nothing", () => {
  const storedFrom = (over: Record<string, unknown> = {}) => ({
    provider: "github",
    number: 1,
    title: "Some change",
    state: "merged",
    url: "https://github.com/o/r/pull/1",
    mergedAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ci: "none",
    ciLabel: null,
    headSha: null,
    ...over,
  });

  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([mergedPR]);
  });

  it("writes nothing, so the task's own updatedAt does not move", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "done",
      linkedPRs: [storedFrom()],
    });

    const result = await syncGithubPullRequests(project(), "u1");

    expect(result).toMatchObject({ tasksWritten: 0 });
    expect(taskUpdateOne).not.toHaveBeenCalled();
    // Still counted as found: the sync did its job, it simply had nothing new to store
    expect(result).toMatchObject({ prsLinked: 1 });
  });

  // The control, and the half that must not be broken by the one above
  it("writes when anything about the pull request has changed", async () => {
    for (const change of [
      { number: 7 },
      { title: "Renamed on GitHub" },
      // On its own, not alongside `state`: the loop only ever moved the two together before
      { mergedAt: new Date("2020-01-01T00:00:00Z") },
      { state: "open", mergedAt: null },
      { ci: "failure" },
      { ciLabel: "e2e" },
      { headSha: "abc123" },
      { url: "https://github.com/o/r/pull/2" },
      { updatedAt: new Date("2020-01-01T00:00:00Z") },
    ] as Record<string, unknown>[]) {
      vi.clearAllMocks();
      taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
      taskFindOne.mockResolvedValue({
        _id: "t1",
        taskNumber: 5,
        status: "done",
        linkedPRs: [storedFrom(change)],
      });

      const result = await syncGithubPullRequests(project(), "u1");

      expect(result, JSON.stringify(change)).toMatchObject({ tasksWritten: 1 });
    }
  });

  it("writes when a pull request appears or disappears", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "done", linkedPRs: [] });

    expect(await syncGithubPullRequests(project(), "u1")).toMatchObject({ tasksWritten: 1 });
  });

  /**
   * `fetchPullRequests` concatenates the open page and the recently-closed page, which are ordered
   * differently, so a task with two linked pull requests genuinely does see them arrive in either
   * order between ticks. Without the sort on both sides that reads as a change, writes, and brings
   * back the `updatedAt` corruption this function exists to prevent — on exactly the tasks with the
   * most pull-request activity.
   *
   * Every other test here has one link, where `.sort()` is the identity and this is unfalsifiable.
   */
  it("is not fooled by the same two pull requests arriving the other way round", async () => {
    fetchPullRequests.mockResolvedValue([
      { ...mergedPR, number: 1 },
      { ...mergedPR, number: 2, html_url: "https://github.com/o/r/pull/2" },
    ]);
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "done",
      // Stored in the opposite order to the one the fetch returns
      linkedPRs: [
        storedFrom({ number: 2, url: "https://github.com/o/r/pull/2" }),
        storedFrom({ number: 1 }),
      ],
    });

    expect(await syncGithubPullRequests(project(), "u1")).toMatchObject({ tasksWritten: 0 });
  });

  // A GitLab link beside it is not this sync's business and must not make it look changed
  it("ignores the other provider's links when deciding", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "done",
      linkedPRs: [storedFrom(), { provider: "gitlab", number: 9, title: "MR", state: "open", url: "u" }],
    });

    expect(await syncGithubPullRequests(project(), "u1")).toMatchObject({ tasksWritten: 0 });
  });
});
