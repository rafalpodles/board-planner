import { describe, it, expect, vi, beforeEach } from "vitest";
import { removeProviderLinks, replaceProviderLinks } from "@/lib/pr-links";

/**
 * BP-429. This route is unchanged by that ticket; the tests are what it was missing. Its
 * transition is still keyed to the seeded column ids, so a board that renamed them opts out in
 * silence — asserted below rather than fixed, because which column merged work lands in is a
 * decision about the pipeline and not one to take while adding a missing argument to a matcher.
 * The network is stubbed; the matcher, the linking rule and the transition all run for real.
 */

// Hoisted: `@/lib/pr-links` above reaches `@/models/task`, so the factory below runs before a
// plain `const` in this scope is initialised (BP-559).
const {
  fetchPullRequests,
  projectFindById,
  taskFind,
  taskFindOne,
  taskUpdateOne,
  logActivity,
} = vi.hoisted(() => ({
  fetchPullRequests: vi.fn(),
  projectFindById: vi.fn(),
  taskFind: vi.fn(),
  taskFindOne: vi.fn(),
  taskUpdateOne: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({
  Task: { find: taskFind, findOne: taskFindOne, updateOne: taskUpdateOne },
}));
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
  over: Partial<{ number: number; ref: string; state: "open" | "closed"; merged_at: string }> = {}
) => ({
  number: over.number ?? 1,
  title: "Some change",
  state: over.state ?? ("open" as const),
  html_url: `https://github.com/o/r/pull/${over.number ?? 1}`,
  merged_at: over.merged_at ?? null,
  head: { ref: over.ref ?? "bp-5/x" },
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
  // BP-610's second pass. The default is a project where no other task holds a GitHub link, so
  // every test above is about the round's own writes, as it was before.
  taskFind.mockReturnValue({ lean: async () => [] });
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
   * BP-610. Somebody retitles a pull request from `BP-5 …` to `BP-7 …` on a branch that carries no
   * key. It leaves BP-5's group entirely, so the loop above never visits BP-5, and before the
   * second pass its link survived every later sync — the same pull request on two cards for ever.
   */
  it("takes a retitled pull request off the task it no longer belongs to", async () => {
    fetchPullRequests.mockResolvedValue([
      { ...pr({ number: 1 }), title: "BP-7 moved here", head: { ref: "no-key-here" } },
    ]);
    taskFindOne.mockResolvedValue(task({ _id: "t7", taskNumber: 7 }));
    taskFind.mockReturnValue({
      lean: async () => [
        { _id: "t5", taskNumber: 5, linkedPRs: [{ provider: "github", number: 1 }] },
      ],
    });

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsUnlinked).toBe(1);
    expect(taskUpdateOne).toHaveBeenCalledWith(
      { _id: "t5" },
      removeProviderLinks("github", [1]),
      { updatePipeline: true }
    );
  });

  /**
   * The half that matters more. GitHub is asked for the open pull requests plus the thirty most
   * recently updated closed ones, so a task whose pull request merged last quarter is outside
   * every fetch while being perfectly correct. "Clear every task not in this round's grouping"
   * would delete it.
   */
  it("leaves a link alone when this round's fetch never mentioned it", async () => {
    fetchPullRequests.mockResolvedValue([pr({ number: 1 })]);
    taskFind.mockReturnValue({
      lean: async () => [
        { _id: "t9", taskNumber: 9, linkedPRs: [{ provider: "github", number: 4321 }] },
      ],
    });

    const body = await (await POST(request(), ctx())).json();

    expect(body.prsUnlinked).toBe(0);
    // The control: the round did its own work, so the silence above is a decision rather than a
    // sync that stopped early.
    expect(body.prsLinked).toBe(1);
    expect(taskUpdateOne).not.toHaveBeenCalledWith(
      { _id: "t9" },
      expect.anything(),
      expect.anything()
    );
  });

  it("does not reach the second pass when the fetch itself failed", async () => {
    // Nothing may be removed on the strength of a round that never happened: the throw leaves the
    // route before any write, and `taskFind` is the proof the sweep was not reached.
    fetchPullRequests.mockRejectedValue(new Error("GitHub API 502"));

    await expect(POST(request(), ctx())).rejects.toThrow("GitHub API 502");
    expect(taskFind).not.toHaveBeenCalled();
  });
});
