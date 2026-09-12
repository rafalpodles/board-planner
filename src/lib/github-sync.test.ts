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

const { syncGithubPullRequests, githubSyncTick } = await import("./github-sync");

const project = (over: Record<string, unknown> = {}) => ({
  _id: "p1",
  key: "BP",
  formerKeys: [],
  repositoryUrl: "https://github.com/o/r",
  githubToken: "enc",
  columns: null,
  ...over,
});

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
