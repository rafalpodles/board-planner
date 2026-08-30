import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BP-429. The post-fetch half of sync had no test at any level, which is how three separate things
 * stayed wrong in it: the matcher never got the project's former keys, the merged-MR transition sent
 * a task to the wrong column, and the activity log recorded a destination the task did not go to.
 * Only the network is stubbed — matching, linking, the per-provider replacement rule and the
 * transition all run for real.
 */

const fetchMergeRequests = vi.fn();
const projectFindById = vi.fn();
const taskFindOne = vi.fn();
const logActivity = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne } }));
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
  vi.clearAllMocks();
  projectFindById.mockReturnValue({ lean: () => project() });
  taskFindOne.mockResolvedValue(task());
  fetchMergeRequests.mockResolvedValue([]);
});

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

describe("POST .../gitlab/sync — linking", () => {
  it("replaces this provider's entries and leaves the other provider's alone", async () => {
    const existing = [
      { provider: "github", number: 7, url: "https://github.com/o/r/pull/7" },
      { provider: "gitlab", number: 99, url: "https://gitlab.com/g/p/-/merge_requests/99" },
    ];
    const doc = task({ linkedPRs: existing });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    await POST(request(), ctx());

    expect(doc.linkedPRs.map((p: { provider: string; number: number }) => [p.provider, p.number])).toEqual([
      ["github", 7],
      ["gitlab", 1],
    ]);
  });

  it("treats a link with no provider recorded as GitHub's, so an old row is not swept away", async () => {
    const doc = task({ linkedPRs: [{ number: 7, url: "https://github.com/o/r/pull/7" }] });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ iid: 1 })]);

    await POST(request(), ctx());

    expect(doc.linkedPRs).toHaveLength(2);
  });
});

describe("POST .../gitlab/sync — the merged-MR transition", () => {
  it("sends a merged task to the last review column, not the next one", async () => {
    // The default board has THREE review columns — in_review, needs_human_review, ready_to_test.
    // "The next review column" put merged work in the queue that exists for a human to look at.
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("ready_to_test");
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

    expect(doc.status).toBe("needs_human_review");
    expect(body.autoTransitioned).toBe(0);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("moves nothing when no merge request is merged — the control", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "opened" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("in_review");
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });

  it("leaves a task that is already in the destination alone", async () => {
    const doc = task({ status: "ready_to_test" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    expect((await (await POST(request(), ctx())).json()).autoTransitioned).toBe(0);
  });

  it("transitions on a board with no seeded column id in it at all", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ columns: RENAMED_COLUMNS }) });
    const doc = task({ status: "checking" });
    taskFindOne.mockResolvedValue(doc);
    fetchMergeRequests.mockResolvedValue([mr({ state: "merged", merged_at: "2026-08-02T00:00:00Z" })]);

    // One review column, so it is both first and last: nothing to advance into.
    expect((await (await POST(request(), ctx())).json()).autoTransitioned).toBe(0);
    expect(doc.status).toBe("checking");
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

    expect(doc.status).toBe("verifying");
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
