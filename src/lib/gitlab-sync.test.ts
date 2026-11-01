import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMergeRequests, taskFindOne, taskFind, taskUpdateOne, logActivity } = vi.hoisted(() => ({
  fetchMergeRequests: vi.fn(),
  taskFindOne: vi.fn(),
  taskFind: vi.fn(),
  taskUpdateOne: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne, find: taskFind, updateOne: taskUpdateOne } }));
vi.mock("@/lib/gitlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gitlab")>()),
  fetchMergeRequests,
}));

const { syncGitlabMergeRequests } = await import("./gitlab-sync");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const db = scopedToDefaultOrganisation();

const COLUMNS = [
  { id: "in_review", name: "In review", role: "review" },
  { id: "ready_to_test", name: "Ready to test", role: "review" },
  { id: "done", name: "Done", role: "done" },
];
const project = {
  _id: "p1",
  key: "GL",
  formerKeys: [],
  gitlabRepo: "group/board",
  gitlabHost: "https://gitlab.example",
  gitlabToken: "enc",
  columns: COLUMNS,
};
const webUrl = "https://gitlab.example/group/board/-/merge_requests/14";
const mergeRequest = (over: Record<string, unknown> = {}) => ({
  iid: 14,
  title: "Mirror both fixes (GL-5, GL-6, GL-7)",
  state: "opened",
  web_url: webUrl,
  merged_at: null,
  source_branch: "gl-5/mirror",
  updated_at: "2026-08-01T10:00:00Z",
  ...over,
});
const link = { provider: "gitlab", number: 14, title: "was", state: "open", url: webUrl };
const task = (taskNumber: number, over: Record<string, unknown> = {}) => ({
  _id: `t${taskNumber}`,
  taskNumber,
  status: "in_progress",
  linkedPRs: [],
  ...over,
});
const writes = () => taskUpdateOne.mock.calls.map(([filter]) => (filter as { _id: string })._id);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMergeRequests.mockResolvedValue([mergeRequest()]);
  taskFindOne.mockImplementation(async ({ taskNumber }: { taskNumber: number }) => task(taskNumber));
  taskFind.mockResolvedValue([]);
  taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe("a merge request that names several tasks (BP-635)", () => {
  it("links it to each task that exists and counts it once", async () => {
    taskFindOne.mockImplementation(async ({ taskNumber }: { taskNumber: number }) =>
      taskNumber === 6 ? null : task(taskNumber)
    );

    const result = await syncGitlabMergeRequests(db, project, "u1");

    expect(writes().sort()).toEqual(["t5", "t7"]);
    expect(result).toMatchObject({ prsFound: 1, prsLinked: 1, tasksLinked: 2 });
  });

  it("unlinks only the task whose key left the list", async () => {
    fetchMergeRequests.mockResolvedValue([mergeRequest({ title: "Mirror one fix (GL-5)" })]);
    taskFindOne.mockImplementation(async ({ taskNumber }: { taskNumber: number }) =>
      task(taskNumber, { linkedPRs: [link] })
    );
    taskFind.mockResolvedValue([task(5, { linkedPRs: [link] }), task(6, { linkedPRs: [link] })]);

    const result = await syncGitlabMergeRequests(db, project, "u1");

    expect(writes().sort()).toEqual(["t5", "t6"]);
    expect(result).toMatchObject({ tasksLinked: 1, prsUnlinked: 1 });
  });

  it("moves every task it lists out of review once merged", async () => {
    fetchMergeRequests.mockResolvedValue([mergeRequest({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);
    taskFindOne.mockImplementation(async ({ taskNumber }: { taskNumber: number }) =>
      task(taskNumber, { status: taskNumber === 7 ? "done" : "in_review" })
    );

    const result = await syncGitlabMergeRequests(db, project, "u1");

    expect(result).toMatchObject({ autoTransitioned: 2 });
  });

  it("neither links nor moves a task the title only mentions", async () => {
    fetchMergeRequests.mockResolvedValue([
      mergeRequest({ title: "Follow-up to GL-6 (GL-5)", state: "merged", merged_at: "2026-08-02T00:00:00Z" }),
    ]);
    taskFindOne.mockImplementation(async ({ taskNumber }: { taskNumber: number }) =>
      task(taskNumber, { status: "in_review" })
    );

    const result = await syncGitlabMergeRequests(db, project, "u1");

    expect(taskFindOne.mock.calls.map(([filter]) => (filter as { taskNumber: number }).taskNumber)).toEqual([5]);
    expect(result).toMatchObject({ tasksLinked: 1, autoTransitioned: 1 });
  });
});
