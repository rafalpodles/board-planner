import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BP-429. The GitHub half of this pair already carried former keys; its transition was the half
 * still keyed to the seeded column ids, so on a renamed board it opted out silently and read as a
 * sync that simply had nothing to do. Both routes now share one rule, which is the only thing that
 * stops them drifting apart again — drift between them is what this ticket was.
 */

const fetchPullRequests = vi.fn();
const projectFindById = vi.fn();
const taskFindOne = vi.fn();
const logActivity = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne } }));
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
  vi.clearAllMocks();
  projectFindById.mockReturnValue({ lean: () => project() });
  taskFindOne.mockResolvedValue(task());
  fetchPullRequests.mockResolvedValue([]);
});

describe("POST .../github/sync", () => {
  it("still finds pull requests opened under a key the project has since left", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ formerKeys: ["CP"] }) });
    fetchPullRequests.mockResolvedValue([pr({ ref: "cp-5/old-prefix" })]);

    expect((await (await POST(request(), ctx())).json()).prsLinked).toBe(1);
  });

  it("replaces this provider's entries and leaves GitLab's alone", async () => {
    const doc = task({
      linkedPRs: [
        { provider: "gitlab", number: 99, url: "https://gitlab.com/g/p/-/merge_requests/99" },
        { provider: "github", number: 7, url: "https://github.com/o/r/pull/7" },
      ],
    });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ number: 1 })]);

    await POST(request(), ctx());

    expect(doc.linkedPRs.map((p: { provider: string; number: number }) => [p.provider, p.number])).toEqual([
      ["gitlab", 99],
      ["github", 1],
    ]);
  });

  it("moves a merged task out of review, and records where it went", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("ready_to_test");
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

  it("transitions on a renamed board, where it used to opt out silently", async () => {
    projectFindById.mockReturnValue({ lean: () => project({ columns: RENAMED_COLUMNS }) });
    const doc = task({ status: "checking" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    await POST(request(), ctx());

    expect(doc.status).toBe("verifying");
  });

  it("does not lift a task out of the queue a human was asked to look at", async () => {
    const doc = task({ status: "needs_human_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ merged_at: "2026-08-02T00:00:00Z" })]);

    await POST(request(), ctx());

    expect(doc.status).toBe("needs_human_review");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("moves nothing when nothing is merged — the control", async () => {
    const doc = task({ status: "in_review" });
    taskFindOne.mockResolvedValue(doc);
    fetchPullRequests.mockResolvedValue([pr({ state: "open" })]);

    const body = await (await POST(request(), ctx())).json();

    expect(doc.status).toBe("in_review");
    expect(body.autoTransitioned).toBe(0);
    expect(body.prsLinked).toBe(1);
  });
});
