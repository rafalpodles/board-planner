import { describe, it, expect, vi, beforeEach } from "vitest";
import { replaceProviderLinks } from "@/lib/pr-links";

/**
 * BP-429. The post-fetch half of sync had no test at any level, which is how three separate things
 * stayed wrong in it: the matcher never got the project's former keys, the merged-MR transition sent
 * a task to the wrong column, and the activity log recorded a destination the task did not go to.
 * The database, the models and auth are stubbed along with the network; the matcher, the
 * per-provider replacement rule and the transition itself all run for real.
 */

// Hoisted: `@/lib/pr-links` above reaches `@/models/task`, so the factory below runs before a
// plain `const` in this scope is initialised (BP-559).
const { fetchMergeRequests, projectFindById, taskFindOne, taskUpdateOne, taskFind, logActivity } =
  vi.hoisted(() => ({
    fetchMergeRequests: vi.fn(),
    projectFindById: vi.fn(),
    taskFindOne: vi.fn(),
    taskUpdateOne: vi.fn(),
    taskFind: vi.fn(),
    logActivity: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
// `find` is the second pass BP-610 added: the tasks this round contradicts without visiting.
// Every test here drives a round whose matches are its whole story, so it answers with nothing.
vi.mock("@/models/task", () => ({
  Task: { findOne: taskFindOne, updateOne: taskUpdateOne, find: taskFind },
}));
// Partial: matchMRsToTasks is the REAL matcher, so the former-keys assertion is about the shipped
// rule rather than about a stub that agrees with itself.
vi.mock("@/lib/gitlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gitlab")>()),
  fetchMergeRequests,
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1" } }),
}));

const { POST } = await import("./route");

const mr = (
  over: Partial<{ iid: number; branch: string; state: "opened" | "merged"; merged_at: string }> = {}
) => ({
  iid: over.iid ?? 1,
  title: "Some change",
  state: over.state ?? ("opened" as const),
  web_url: `https://gitlab.com/g/p/-/merge_requests/${over.iid ?? 1}`,
  merged_at: over.merged_at ?? null,
  source_branch: over.branch ?? "bp-5/x",
  updated_at: "2026-08-01T00:00:00Z",
});

// The renamed board from BP-110's tests: no seeded id appears in it anywhere.
const RENAMED_COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#000", role: "backlog", order: 0 },
  { id: "building", label: "Building", color: "#000", role: "active", order: 1 },
  { id: "checking", label: "Checking", color: "#000", role: "review", order: 2 },
  { id: "shipped", label: "Shipped", color: "#000", role: "done", order: 3 },
];

function project(over: Record<string, unknown> = {}) {
  return {
    _id: "p1",
    key: "BP",
    formerKeys: [],
    repositoryUrl: "https://gitlab.com/g/p",
    gitlabToken: "enc",
    gitlabHost: "https://gitlab.com",
    columns: null,
    ...over,
  };
}

function task(over: Record<string, unknown> = {}) {
  return { _id: "t1", taskNumber: 5, status: "in_review", linkedPRs: [], save: vi.fn(), ...over };
}

const request = () =>
  new Request("https://app.example.com/api/projects/p1/gitlab/sync", { method: "POST" });
const ctx = () => ({ params: Promise.resolve({ projectId: "p1" }) });

beforeEach(() => {
  taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  vi.clearAllMocks();
  projectFindById.mockReturnValue({ lean: () => project() });
  taskFindOne.mockResolvedValue(task());
  taskFind.mockResolvedValue([]);
  fetchMergeRequests.mockResolvedValue([]);
});

/** The history rows of one action: a link change writes rows of its own now, so "nothing was
 *  logged" has to say which nothing it means (BP-628). */
const rowsOf = (action: string) =>
  logActivity.mock.calls.filter((call: unknown[]) => call[2] === action);

describe("POST .../gitlab/sync — matching", () => {
  it("still finds merge requests opened under a key the project has since left", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ key: "BP", formerKeys: ["CP"] }) });
    fetchMergeRequests.mockResolvedValue([mr({ branch: "cp-5/old-prefix" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsFound).toBe(1);
    expect(body.prsLinked).toBe(1);
  });

  it("finds nothing under that old prefix when the project never had the key", async () => {
    fetchMergeRequests.mockResolvedValue([mr({ branch: "cp-5/old-prefix" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsFound).toBe(0);
  });
});

// The round names what it saw by url, not by number (BP-631)
const mrUrl = (iid: number) => `https://gitlab.com/g/p/-/merge_requests/${iid}`;

describe("POST .../gitlab/sync — linking", () => {
  it("names its own provider, which is what decides whose links are replaced", async () => {
    const doc = task();
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 7 })]);

    await POST(request(), ctx());

    // Which link survives is asserted against a real database in `e2e/pr-link-replacement.spec.ts`;
    // what this pins is that the route hands the job over rather than saving a copy (BP-559)
    const [filter, update, options] = taskUpdateOne.mock.calls[0];
    // Both options, for the reason its GitHub twin carries: a sync is not an edit (BP-627)
    expect(options).toEqual({ updatePipeline: true, timestamps: false });
    expect(filter).toEqual({ _id: doc._id });
    expect(update).toEqual(
      replaceProviderLinks(
        "gitlab",
        [expect.objectContaining({ provider: "gitlab", number: 7 })],
        [mrUrl(7)]
      )
    );
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("sends a merged task to the last review column, not the next one", async () => {
    // The default board has THREE review columns — in_review, needs_human_review, ready_to_test.
    // "The next review column" put merged work in the queue that exists for a human to look at.
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(taskUpdateOne).toHaveBeenCalledWith(
      { _id: doc._id, status: doc.status },
      { $set: { status: "ready_to_test" } }
    );
    expect(body.autoTransitioned).toBe(1);
  });

  it("records the column it actually moved to", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    await POST(request(), ctx());

    expect(logActivity).toHaveBeenCalledWith(
      "t1",
      "u1",
      "status_changed",
      "status",
      "in_review",
      "ready_to_test"
    );
  });

  it("does not lift a task out of the queue a human was asked to look at", async () => {
    const doc = task({ status: "needs_human_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    // No status write reached the database at all — the only call is the link replacement
    expect(
      taskUpdateOne.mock.calls.filter(([, update]) => !Array.isArray(update))
    ).toHaveLength(0);
    expect(body.autoTransitioned).toBe(0);
    expect(rowsOf("status_changed")).toHaveLength(0);
    // The control: the route reached this task and linked its merge request, so the status
    // standing still is a decision rather than a sync that did nothing at all.
    expect(body.prsLinked).toBe(1);
  });

  it("moves nothing when no merge request is merged — the control", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "opened" })]);

    const body = await (await POST(request(), ctx())).json();

    // No status write reached the database at all — the only call is the link replacement
    expect(
      taskUpdateOne.mock.calls.filter(([, update]) => !Array.isArray(update))
    ).toHaveLength(0);
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });

  it("leaves a task that is already in the last review column alone", async () => {
    const doc = task({ status: "ready_to_test" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    // No status write reached the database at all — the only call is the link replacement
    expect(
      taskUpdateOne.mock.calls.filter(([, update]) => !Array.isArray(update))
    ).toHaveLength(0);
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });

  it("does not lift a task out of a flagged column even when that column sorts first", async () => {
    // The rule reads the flag, not the position. Under the positional one this board — the same
    // columns, dragged into a different order — moved a task straight out of the human queue,
    // which is what the two tests above are named after preventing.
    const reordered = [
      { id: "needs_human_review", label: "Needs Human Review", color: "#000", role: "review", order: 0, triggersPmReview: true },
      { id: "in_review", label: "In Review", color: "#000", role: "review", order: 1 },
      { id: "ready_to_test", label: "Ready to Test", color: "#000", role: "review", order: 2 },
      { id: "done", label: "Done", color: "#000", role: "done", order: 3 },
    ];
    projectFindById.mockReturnValue({ lean: () => project({ columns: reordered }) });
    const doc = task({ status: "needs_human_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    // No status write reached the database at all — the only call is the link replacement
    expect(
      taskUpdateOne.mock.calls.filter(([, update]) => !Array.isArray(update))
    ).toHaveLength(0);
    expect(body.prsLinked).toBe(1);
  });

  it("transitions nothing on a board whose one review column is both first and last", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ columns: RENAMED_COLUMNS }) });
    const doc = task({ status: "checking" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    // One review column, so there is nothing to advance into.
    const body = await (await POST(request(), ctx())).json();
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
    expect(
      taskUpdateOne.mock.calls.filter(([, update]) => !Array.isArray(update))
    ).toHaveLength(0);
  });

  it("advances along a renamed board that has two review columns", async () => {
    const columns = [
      ...RENAMED_COLUMNS.slice(0, 3),
      { id: "verifying", label: "Verifying", color: "#000", role: "review", order: 3 },
      { id: "shipped", label: "Shipped", color: "#000", role: "done", order: 4 },
    ];
    projectFindById.mockReturnValue({ lean: () => project({ columns }) });
    const doc = task({ status: "checking" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    await POST(request(), ctx());

    expect(taskUpdateOne).toHaveBeenCalledWith(
      { _id: doc._id, status: doc.status },
      { $set: { status: "verifying" } }
    );
    // On the default board the destination happens to BE "ready_to_test", so the hardcoded string
    // this route used to log was indistinguishable from the real one. Here it is not.
    expect(logActivity).toHaveBeenCalledWith(
      "t1",
      "u1",
      "status_changed",
      "status",
      "checking",
      "verifying"
    );
  });
});

/**
 * BP-610's second pass, on the provider that never got tests for it: a merge request retitled onto
 * another task leaves its old task's grouping, so that task is not in the loop the round walks and
 * its stale link used to survive every later sync. The `provider` filter is the half that matters
 * here — GitHub's links are on the same array, and a GitLab round must not adopt or prune them
 * (BP-610 review).
 */
describe("POST .../gitlab/sync — the tasks a round contradicts without visiting", () => {
  // The address follows the number. It did not before, so `link({ number: 9 })` was a link to
  // merge request 1 wearing a 9 — a fixture no round could tell apart from the one beside it
  // once the round started naming what it saw by url (BP-631).
  const link = (over: Record<string, unknown> = {}) => ({
    provider: "gitlab",
    number: 1,
    title: "Some change",
    state: "open",
    url: mrUrl((over.number as number) ?? 1),
    ...over,
  });

  it("visits a task this round contradicts but never matched, and counts what it removed", async () => {
    // Merge request 1 used to be task 8's, and this round gave it to task 5
    taskFind.mockResolvedValue([{ _id: "t8", taskNumber: 8, linkedPRs: [link(), link({ number: 9, state: "merged" })] }]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    const body = await (await POST(request(), ctx())).json();

    expect(taskFind).toHaveBeenCalledWith({
      project: "p1",
      linkedPRs: { $elemMatch: { url: { $in: [mrUrl(1)] }, provider: "gitlab" } },
    });
    const pruned = taskUpdateOne.mock.calls.find(([filter]) => filter._id === "t8");
    expect(pruned?.[1]).toEqual(replaceProviderLinks("gitlab", [], [mrUrl(1)]));
    expect(body.prsUnlinked).toBe(1);
  });

  it("leaves a task alone when the round contradicts nothing it holds", async () => {
    taskFind.mockResolvedValue([{ _id: "t8", taskNumber: 8, linkedPRs: [link({ number: 9, state: "merged" })] }]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    const body = await (await POST(request(), ctx())).json();

    expect(taskUpdateOne.mock.calls.find(([filter]) => filter._id === "t8")).toBeUndefined();
    expect(body.prsUnlinked).toBe(0);
  });

  it("does not prune the task the round did match, from the second pass as well as the first", async () => {
    // The query is a database query, so a task in this round's grouping comes back from it too
    taskFind.mockResolvedValue([{ _id: "t1", taskNumber: 5, linkedPRs: [link()] }]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    await POST(request(), ctx());

    expect(taskUpdateOne.mock.calls.filter(([filter]) => filter._id === "t1")).toHaveLength(1);
  });

  it("counts a merge request the round saw but matched to nobody", async () => {
    // `seen` is built from the matched MRs' `number` AND the raw ones' `iid`, and nothing pinned
    // that those are the same id space (found in review). This round matches nothing — the branch
    // names no task — so 1 can only reach `seen` through the raw half.
    taskFind.mockResolvedValue([{ _id: "t8", taskNumber: 8, linkedPRs: [link()] }]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1, branch: "no-task-here" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsFound).toBe(0);
    expect(taskFind).toHaveBeenCalledWith({
      project: "p1",
      linkedPRs: { $elemMatch: { url: { $in: [mrUrl(1)] }, provider: "gitlab" } },
    });
    expect(body.prsUnlinked).toBe(1);
  });

  it("never answers the query with an unmarked link, which is GitHub's", async () => {
    taskFind.mockResolvedValue([]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    await POST(request(), ctx());

    const [query] = taskFind.mock.calls[0];
    expect(query.linkedPRs.$elemMatch.provider).toBe("gitlab");
  });
});

/**
 * The GitLab half of BP-631 and BP-628: a round's field of view is one repository's, and what it
 * changes about a task is written into that task's history.
 */
describe("POST .../gitlab/sync — what a round may contradict, and what it records", () => {
  it("leaves the previous repository's merge request number alone", async () => {
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          {
            provider: "gitlab",
            number: 1,
            title: "Opened before the move",
            state: "opened",
            url: "https://gitlab.com/g/previous/-/merge_requests/1",
          },
        ],
      },
    ]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    const body = await (await POST(request(), ctx())).json();

    expect(taskUpdateOne.mock.calls.find(([filter]) => filter._id === "t8")).toBeUndefined();
    expect(body.prsUnlinked).toBe(0);
    // The control: the round reached its own task and linked its merge request
    expect(body.prsLinked).toBe(1);
  });

  it("writes a row naming the merge request it linked", async () => {
    taskFindOne.mockResolvedValue(task());
    fetchMergeRequests.mockResolvedValue([mr({ iid: 7 })]);

    await POST(request(), ctx());

    expect(rowsOf("pr_linked")).toEqual([
      ["t1", "u1", "pr_linked", "linkedPRs", "", mrUrl(7)],
    ]);
  });

  it("writes one naming what it took away", async () => {
    taskFind.mockResolvedValue([
      {
        _id: "t8",
        taskNumber: 8,
        linkedPRs: [
          { provider: "gitlab", number: 1, title: "Was task 8's", state: "opened", url: mrUrl(1) },
        ],
      },
    ]);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    await POST(request(), ctx());

    expect(rowsOf("pr_unlinked")).toEqual([
      ["t8", "u1", "pr_unlinked", "linkedPRs", mrUrl(1), ""],
    ]);
  });
});
