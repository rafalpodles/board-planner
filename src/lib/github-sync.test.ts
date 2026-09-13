import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * BP-443. The sync moved out of its route so a background tick could run the same code, and the
 * one thing that separates the two callers is asserted here: a tick has nobody to name, so it
 * refreshes what the badges show and moves no task between columns.
 */

const { fetchPullRequests, projectFind, taskFindOne, taskUpdateOne, taskFind, logActivity } =
  vi.hoisted(() => ({
    fetchPullRequests: vi.fn(),
    projectFind: vi.fn(),
    taskFindOne: vi.fn(),
    taskUpdateOne: vi.fn(),
    taskFind: vi.fn(),
    logActivity: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
// `find` is the second pass BP-610 added: the tasks this round contradicts without visiting.
// Every test here drives a round whose matches are its whole story, so it answers with nothing.
vi.mock("@/models/task", () => ({
  Task: { findOne: taskFindOne, updateOne: taskUpdateOne, find: taskFind },
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequests,
}));

const { syncGithubPullRequests, githubSyncTick, syncTickMs } = await import("./github-sync");

/** The history rows of one action. A link change writes rows too now, so "nothing was logged" has
 *  to name which nothing it means (BP-628). */
const rowsOf = (action: string) =>
  logActivity.mock.calls.filter((call: unknown[]) => call[2] === action);

/** Every action a round wrote a row for. Asserting this rather than one action keeps the old
 *  guarantee that nothing ELSE was logged either. */
const actionsLogged = () => logActivity.mock.calls.map((call: unknown[]) => call[2]).sort();

const project = (over: Record<string, unknown> = {}) => ({
  _id: "p1",
  key: "BP",
  formerKeys: [],
  repositoryUrl: "https://github.com/o/r",
  githubToken: "enc",
  columns: null,
  ...over,
});

// The fixture repository, so a stored link's address and a fetched pull request's agree — which
// is what the round compares now that it names what it saw by url (BP-631)
const prUrl = (number: number) => `https://github.com/o/r/pull/${number}`;

type Written = {
  $set: {
    linkedPRs: {
      $concatArrays: [
        { $filter: { cond: { $or?: [unknown, { $not: [{ $in: [unknown, string[]] }] }] } } },
        { $literal: Record<string, unknown>[] },
      ];
    };
  };
};

/** Each link write, read back out of the pipeline the route handed the database. */
const linkArgs = () =>
  taskUpdateOne.mock.calls.map(([filter, update]) => {
    const [stage] = update as Written[];
    const [keep, add] = stage.$set.linkedPRs.$concatArrays;
    return {
      id: (filter as { _id: string })._id,
      written: add.$literal.map((doc) => doc.number),
      // Read straight, with no fallback for a missing `$or`: `replaceProviderLinks` always
      // emits one, so the branch that guarded against its absence could never run and only hid
      // a shape change behind a `null` some assertion would have to interpret (found in review).
      seen: keep.$filter.cond.$or![1].$not[0].$in[1],
    };
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
  taskFind.mockResolvedValue([]);
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
    expect(actionsLogged()).toEqual(["pr_linked"]);
    // The link row is written all the same, with no actor: the absence that stops a column change
    // being attributed is not a reason to leave the link change untraceable (BP-628, BP-632)
    expect(rowsOf("pr_linked")).toEqual([
      ["t1", null, "pr_linked", "linkedPRs", "", "https://github.com/o/r/pull/1"],
    ]);
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
  // The stored links below carry a `url`, which the schema requires and these fixtures used to
  // omit: `carryForward` matches on it since a repointed project's task can hold two links
  // wearing the same number (BP-631).
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
      linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci: "success", ciLabel: "e2e", headSha: "abc123" }],
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
      linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci: "success", ciLabel: "e2e", headSha: "older" }],
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
      linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci: "running", ciLabel: "e2e", headSha: "abc123" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown", ciLabel: null });
  });

  // The observed outcomes are kept, which is the whole point of carrying anything forward
  it("keeps the outcomes that had finished when we last looked", async () => {
    for (const ci of ["success", "failure"]) {
      vi.clearAllMocks();
      taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
      githubRefusesChecks();
      taskFindOne.mockResolvedValue({
        _id: "t1",
        taskNumber: 5,
        status: "todo",
        linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci, ciLabel: "e2e", headSha: "abc123" }],
      });

      await syncGithubPullRequests(project(), "u1");

      expect(linkWritten()[0], ci).toMatchObject({ ci });
    }
  });

  /**
   * `none` is not an outcome, it is the absence of one — and carried, it is byte-identical to a
   * pull request that genuinely has no CI. A build that started after the first sync and then
   * failed would read as a plain "open" badge for ever, with nothing on screen to suggest looking
   * again, and `unchanged` would make that stable as well as wrong. The docstring above the set
   * said "finished" while the set said otherwise.
   */
  it("does not carry 'nothing had started yet' forward as if it were news", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci: "none", ciLabel: null, headSha: "abc123" }],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown" });
  });

  /**
   * Since BP-631 a repointed project's task holds both repositories' links, and two of them can
   * wear the same number. Matched on the number, the answer stored for the OTHER repository's #1
   * is what this finds — and `headSha` is the only thing that refused it, so a stored answer with
   * a matching commit would have been carried onto a different pull request (found in review).
   */
  it("does not carry an answer stored for another repository's same number", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [
        {
          provider: "github",
          number: 1,
          url: "https://github.com/o/previous/pull/1",
          ci: "success",
          ciLabel: "e2e",
          headSha: "abc123",
        },
      ],
    });

    await syncGithubPullRequests(project(), "u1");

    expect(linkWritten()[0]).toMatchObject({ ci: "unknown", ciLabel: null });
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
      linkedPRs: [{ provider: "github", number: 1, url: prUrl(1), ci: "success", ciLabel: "e2e", headSha: "abc123" }],
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
    expect(actionsLogged()).toEqual(["pr_linked"]);
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
    expect(actionsLogged()).toEqual(["pr_linked"]);
  });
});

/**
 * CLAUDE.md documents `0` as the operator's off switch. A value that is not a number used to read
 * as NaN and silently never start, which is indistinguishable from a sync that is working.
 */
/**
 * `getTime()` on an Invalid Date is `NaN`, which `JSON.stringify` writes as `null` — the same as an
 * absent date and the same as every other Invalid Date, so two different malformed dates would
 * compare equal for ever.
 */
describe("a date that is not a date", () => {
  /**
   * Against an **absent** date, not a valid one. `getTime()` on an Invalid Date is `NaN`, which
   * `JSON.stringify` writes as `null` — exactly how an absent date is written. Comparing it to a
   * real date differs either way and proves nothing; the first version of this test did that and
   * stayed green against the collapse it was written for.
   */
  it("does not compare equal to an absent one", async () => {
    // The fetched pull request is open, so its mergedAt is genuinely null
    fetchPullRequests.mockResolvedValue([openPR]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("/check-runs")
              ? { total_count: 0, check_runs: [] }
              : { state: "pending", statuses: [] }
          ),
          { status: 200 }
        )
      )
    );
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "done",
      linkedPRs: [
        {
          provider: "github",
          number: 1,
          title: "Some change",
          state: "open",
          url: "https://github.com/o/r/pull/1",
          // The only difference from what the sync will produce
          mergedAt: new Date("not a date"),
          updatedAt: new Date("2026-08-01T00:00:00Z"),
          ci: "none",
          ciLabel: null,
          headSha: "abc123",
        },
      ],
    });

    expect(await syncGithubPullRequests(project(), "u1")).toMatchObject({ tasksWritten: 1 });
  });
});

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

  /**
   * "Off" and "already running" used to be the same `0`, so a second `register()` — which
   * `next dev` does on reload — logged that the sync was switched off while it was running.
   */
  it("tells being off apart from having already started", async () => {
    vi.resetModules();
    vi.stubEnv("GITHUB_SYNC_TICK_MS", "0");
    const off = await import("./github-sync");
    expect(off.startGithubSyncScheduler()).toEqual({ started: false, reason: "off" });

    vi.resetModules();
    vi.stubEnv("GITHUB_SYNC_TICK_MS", "600000");
    const on = await import("./github-sync");
    expect(on.startGithubSyncScheduler()).toEqual({ started: true, tickMs: 600000 });
    expect(on.startGithubSyncScheduler()).toEqual({
      started: false,
      reason: "already running",
    });
    vi.unstubAllEnvs();
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

/**
 * BP-617 and BP-610, which are one rule seen from two sides: a fetch is a window, so a link the
 * round did not see is unknown and a link it saw and gave to somebody else is gone.
 *
 * The pipeline's *meaning* — which link survives the write — is asserted against a real database
 * in `e2e/pr-link-replacement.spec.ts`. What is pinned here is the decision this module takes: who
 * is written, who is visited, and what the operator is told.
 */
describe("what a round of the window may say about a link", () => {
  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([openPR]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 }))
    );
  });

  it("hands the write every pull request the round saw, not only the ones it matched", async () => {
    // A second pull request in the fetch that belongs to no task at all: it is still a fact about
    // the round, and it is what makes a removal a fact rather than a guess.
    fetchPullRequests.mockResolvedValue([openPR, { ...openPR, number: 77, head: { ref: "chore/none", sha: "z" } }]);
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    taskFind.mockResolvedValue([]);

    await syncGithubPullRequests(project(), "u1");

    expect(linkArgs()[0].seen?.slice().sort() ?? null).toEqual([prUrl(1), prUrl(77)].sort());
  });

  it("does not write a task whose only change would be keeping a link out of the window", async () => {
    // Task 5 holds 1 (this round's match, unchanged) and 9 (merged last quarter, out of window)
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "done",
      linkedPRs: [
        {
          provider: "github",
          number: 1,
          title: "Some change",
          state: "open",
          url: "https://github.com/o/r/pull/1",
          mergedAt: null,
          updatedAt: new Date("2026-08-01T00:00:00Z"),
          ci: "none",
          ciLabel: null,
          headSha: "abc123",
        },
        {
          provider: "github",
          number: 9,
          title: "Older",
          state: "merged",
          url: "https://github.com/o/r/pull/9",
          mergedAt: new Date("2026-05-01T00:00:00Z"),
          updatedAt: new Date("2026-05-01T00:00:00Z"),
          ci: "none",
          ciLabel: null,
          headSha: null,
        },
      ],
    });
    taskFind.mockResolvedValue([]);

    const result = await syncGithubPullRequests(project(), "u1");

    // The out-of-window link is not in this round's docs, so a comparison against the docs alone
    // would call this changed and write every five minutes — moving `updatedAt` on a done task,
    // which is the corruption `unchanged` exists to prevent.
    expect(result).toMatchObject({ tasksWritten: 0, prsUnlinked: 0 });
    expect(taskUpdateOne).not.toHaveBeenCalled();
  });

  it("visits a task this round contradicts but never matched, and counts what it removed", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    // Pull request 1 used to be task 8's, and this round gave it to task 5
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          { provider: "github", number: 1, title: "Some change", state: "open", url: prUrl(1) },
          { provider: "github", number: 9, title: "Older", state: "merged", url: prUrl(9) },
        ],
      },
    ]);

    const result = await syncGithubPullRequests(project(), "u1");

    const pruned = linkArgs().find((call) => call.id === "t8");
    expect(pruned?.written).toEqual([]);
    expect(result).toMatchObject({ prsUnlinked: 1 });
  });

  it("leaves a task alone when the round contradicts nothing it holds", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    taskFind.mockResolvedValue([
      { _id: "t8", taskNumber: 8, linkedPRs: [{ provider: "github", number: 9, title: "Older", state: "merged", url: prUrl(9) }] },
    ]);

    const result = await syncGithubPullRequests(project(), "u1");

    expect(linkArgs().find((call) => call.id === "t8")).toBeUndefined();
    expect(result).toMatchObject({ prsUnlinked: 0 });
  });

  it("does not prune the task the round did match, from the second pass as well as the first", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    // The query is a database query, so a task in this round's grouping can come back from it too
    taskFind.mockResolvedValue([
      { _id: "t1", taskNumber: 5, linkedPRs: [{ provider: "github", number: 1, title: "x", state: "open", url: prUrl(1) }] },
    ]);

    await syncGithubPullRequests(project(), "u1");

    expect(linkArgs().filter((call) => call.id === "t1")).toHaveLength(1);
  });
});

/**
 * BP-631. A round's field of view is one repository's, and a number is only unique inside one —
 * so a project whose `repositoryUrl` has been repointed used to have the *old* repository's links
 * pruned by the new one's numbers, which is a real pull request deleted over a collision nothing
 * observed.
 */
describe("a project whose repository has moved", () => {
  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([openPR]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 }))
    );
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
  });

  it("asks the database for the addresses it saw, not the numbers", async () => {
    taskFind.mockResolvedValue([]);

    await syncGithubPullRequests(project(), "u1");

    expect(taskFind.mock.calls[0][0]).toEqual({
      project: "p1",
      linkedPRs: {
        $elemMatch: { url: { $in: [prUrl(1)] }, provider: { $in: ["github", null] } },
      },
    });
  });

  it("leaves the previous repository's pull request number alone", async () => {
    // The query is scoped by url now, so this task would not come back from it at all — it is
    // answered here anyway, because a rule that only holds while the query narrows correctly is
    // one bad projection away from deleting the link again.
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          {
            provider: "github",
            number: 1,
            title: "Opened before the move",
            state: "open",
            url: "https://github.com/o/previous/pull/1",
          },
        ],
      },
    ]);

    const result = await syncGithubPullRequests(project(), "u1");

    expect(taskUpdateOne.mock.calls.find(([filter]) => filter._id === "t8")).toBeUndefined();
    expect(result).toMatchObject({ prsUnlinked: 0 });
    // The control: the round did reach its own task and wrote its link, so the silence above is
    // the rule rather than a sync that did nothing
    expect(result).toMatchObject({ prsLinked: 1, tasksWritten: 1 });
  });

  /**
   * The other side of the same coin, and the reason the round claims the project's own spelling as
   * well as GitHub's. A renamed repository answers through a redirect under its NEW name while the
   * project still names the old one, so the links already stored are addressed the old way — and
   * without this they would survive every later round beside their own replacement.
   */
  it("still prunes the old name's links after a rename", async () => {
    const renamed = project({ repositoryUrl: "https://github.com/o/before-the-rename" });
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          {
            provider: "github",
            number: 1,
            title: "Stored under the old name",
            state: "open",
            url: "https://github.com/o/before-the-rename/pull/1",
          },
        ],
      },
    ]);

    const result = await syncGithubPullRequests(renamed, "u1");

    expect(taskUpdateOne.mock.calls.find(([filter]) => filter._id === "t8")).toBeDefined();
    expect(result).toMatchObject({ prsUnlinked: 1 });
  });
});

/**
 * BP-628 and BP-632. `updatedAt` stopped moving on a link change (BP-627), no webhook fires from
 * either sync route, and the toast reaches nobody on a scheduler tick — so a link arriving on a
 * task, or leaving it, left no trace anywhere a person could look.
 */
describe("what a link change leaves behind", () => {
  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([openPR]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 }))
    );
  });

  it("writes a row on the task the round took a link off, with no actor on a tick", async () => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          { provider: "github", number: 1, title: "Was task 8's", state: "open", url: prUrl(1) },
        ],
      },
    ]);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await githubSyncTick();

    expect(rowsOf("pr_unlinked")).toEqual([
      ["t8", null, "pr_unlinked", "linkedPRs", prUrl(1), ""],
    ]);
  });

  // A round that only refreshed a badge changed no link, and a history of "the sync looked again"
  // is a history nobody can read
  it("writes nothing for a link the round re-matched to the same task", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [
        {
          provider: "github",
          number: 1,
          title: "Some change",
          state: "open",
          url: prUrl(1),
          mergedAt: null,
          updatedAt: new Date("2026-08-01T00:00:00Z"),
          ci: "none",
          ciLabel: null,
          // A different head commit, so the task IS written — what must stay silent is the row,
          // not the write
          headSha: "older",
        },
      ],
    });
    taskFind.mockResolvedValue([]);

    const result = await syncGithubPullRequests(project(), "u1");

    expect(result).toMatchObject({ tasksWritten: 1 });
    expect(rowsOf("pr_linked")).toEqual([]);
    expect(rowsOf("pr_unlinked")).toEqual([]);
  });

  it("says on the log what a scheduled round unlinked", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          { provider: "github", number: 1, title: "Was task 8's", state: "open", url: prUrl(1) },
        ],
      },
    ]);

    await githubSyncTick();

    // The count of tasks is the ones it took a link OFF, not every task the round rewrote —
    // most writes remove nothing, and a line that said otherwise would be a claim the numbers
    // beside it contradict
    expect(info).toHaveBeenCalledWith(
      "GitHub sync unlinked 1 pull request(s) from 1 task(s) on BP"
    );
  });

  it("says nothing at all when a round unlinked nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 5, status: "todo", linkedPRs: [] });
    taskFind.mockResolvedValue([]);

    await githubSyncTick();

    expect(info).not.toHaveBeenCalled();
  });
});

/**
 * The half of the rename BP-631 does not cover, pinned so that it is a decision rather than an
 * accident: once the project's own url has been changed to the new name too, a rename is
 * byte-identical to a repoint — same fetch, same setting — and the rule keeps both links.
 *
 * Which way to be wrong is the whole question. This way costs a visible duplicate badge that
 * redirects to the same pull request; the other way is the silent deletion of a link to a pull
 * request that still exists, which is the defect BP-631 was filed for.
 */
describe("a rename the project's own url has caught up with", () => {
  beforeEach(() => {
    fetchPullRequests.mockResolvedValue([openPR]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "pending", statuses: [] }), { status: 200 }))
    );
    taskFind.mockResolvedValue([]);
  });

  it("keeps the old name's link beside the new one, and says nothing went", async () => {
    taskFindOne.mockResolvedValue({
      _id: "t1",
      taskNumber: 5,
      status: "todo",
      linkedPRs: [
        {
          provider: "github",
          number: 1,
          title: "Written before the rename",
          state: "open",
          url: "https://github.com/o/before-the-rename/pull/1",
        },
      ],
    });

    const result = await syncGithubPullRequests(project(), "u1");

    // The write keeps what it did not see: only this round's own doc is written, and the filter
    // leaves the other one alone
    expect(linkArgs()[0].written).toEqual([1]);
    expect(result).toMatchObject({ prsUnlinked: 0 });
    expect(rowsOf("pr_unlinked")).toEqual([]);
    // And the row that IS written, because by address this is a link the task did not have
    expect(rowsOf("pr_linked")).toHaveLength(1);
  });
});
