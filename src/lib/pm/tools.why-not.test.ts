import { describe, it, expect, vi, beforeEach } from "vitest";

const taskFindOne = vi.fn();
const projectFindById = vi.fn();
const assignTaskMock = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { find: vi.fn(), countDocuments: vi.fn(), findOne: taskFindOne } }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/comment", () => ({ Comment: { find: vi.fn(), create: vi.fn() } }));
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  assignTask: assignTaskMock,
}));

const { PM_TOOLS } = await import("./tools");

const ctx = { projectId: "p1", projectKey: "BP", pmUserId: "pm", triggeredByUserId: "u1" };

const COLUMNS = [
  { id: "todo", label: "To do", color: "#000", role: "approved", order: 0 },
  { id: "doing", label: "Doing", color: "#000", role: "active", order: 1 },
  { id: "check", label: "Check", color: "#000", role: "review", order: 2 },
  { id: "done", label: "Done", color: "#000", role: "done", order: 3 },
];
const OWNER = { _id: "u1", username: "owner", fullName: "Owner" };
const READY_BOARD = {
  key: "BP",
  columns: COLUMNS,
  worker: { enabled: true },
  repositoryUrl: "https://github.com/acme/bp",
};
const SOUND = { taskNumber: 9, agent: "a1", status: "todo", assignee: OWNER, assignedBy: OWNER };

// Honours the projection, so a field the tool forgets to select is absent here too
function board(over: Record<string, unknown> = {}) {
  projectFindById.mockImplementation((_id: string, projection: string) => {
    const keep = new Set(projection.split(/\s+/));
    const doc = { ...READY_BOARD, ...over } as Record<string, unknown>;
    return { lean: async () => Object.fromEntries(Object.entries(doc).filter(([k]) => keep.has(k))) };
  });
}

async function assign(task: Record<string, unknown> = {}) {
  assignTaskMock.mockResolvedValue({ ok: true, data: { ...SOUND, ...task } });
  return PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: "owner" }, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 9 });
  board();
});

/** BP-727 review: the PM's sentence is built from the same two judgements the task screen shows. */
describe("the PM says every reason its hand-over will not run", () => {
  it("says nothing more on a ready board and a sound task", async () => {
    const { result } = await assign();

    expect(result).toEqual({ task: "BP-9", assignee: "owner" });
  });

  it("names a board with no repository", async () => {
    board({ repositoryUrl: "" });

    const { result } = await assign();

    expect(result).toMatchObject({ willRun: false, note: expect.stringContaining("names no repository") });
  });

  // A legacy board naming its repository only in githubRepo is not missing one
  it("reads a legacy repository field as a repository", async () => {
    board({ repositoryUrl: undefined, githubRepo: "acme/bp" });

    expect((await assign()).result).toEqual({ task: "BP-9", assignee: "owner" });
  });

  it("lists the task's reasons and the board's together", async () => {
    board({ repositoryUrl: "", worker: { enabled: false } });

    const { result } = await assign({ status: "backlog-ish" });
    const note = (result as { note: string }).note;

    expect(note).toContain("not in a column a machine claims from");
    expect(note).toContain("names no repository");
    expect(note).toContain("not enabled for workers");
  });

  // BP-736's lock wins over the owner's switch, and is named as the lock
  it("names an instance admin's lock on a board its owner switched on", async () => {
    board({ worker: { enabled: true, lockedByInstance: true } });

    const note = ((await assign()).result as { note: string }).note;
    expect(note).toBe(
      "Assigned, but an instance admin has locked workers off for this project, so nothing will run it."
    );
  });

  it("names a board missing a column a run needs", async () => {
    board({ columns: COLUMNS.filter((c) => c.role !== "review") });

    expect((await assign()).result).toMatchObject({
      note: expect.stringContaining("the board has no Awaiting review column"),
    });
  });

  it("names every missing role as a list of their labels", async () => {
    board({ columns: COLUMNS.filter((c) => c.role === "active") });

    expect((await assign()).result).toMatchObject({
      note: expect.stringContaining("no Ready to pick up, Awaiting review or Done column"),
    });
  });

  it("names a task machines have spent every attempt on", async () => {
    expect((await assign({ execution: { attempts: 3 } })).result).toMatchObject({
      note: expect.stringContaining("none will take it again"),
    });
  });

  it("does not name attempts a task still has", async () => {
    expect((await assign({ execution: { attempts: 2 } })).result).toEqual({ task: "BP-9", assignee: "owner" });
  });

  // assignTask answers a Mongoose document, whose fields are getters and do not survive a spread
  it("reads the task's fields off a document rather than spreading it", async () => {
    const doc = Object.create({ ...SOUND, agent: null });
    assignTaskMock.mockResolvedValue({ ok: true, data: doc });

    const { result } = await PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: "owner" }, ctx);

    expect((result as { note: string }).note).toContain("no agent is named on it");
  });

  it("finds a sound document sound", async () => {
    assignTaskMock.mockResolvedValue({ ok: true, data: Object.create(SOUND) });

    const { result } = await PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: "owner" }, ctx);

    expect(result).toEqual({ task: "BP-9", assignee: "owner" });
  });

  // A board deleted between the assignment and this read answers, rather than throwing
  it("does not throw when the project is gone", async () => {
    projectFindById.mockReturnValue({ lean: async () => null });

    expect((await assign()).result).toMatchObject({
      note: "Assigned, but this project is not enabled for workers, so nothing will run it.",
    });
  });

  it("names unfinished blockers by key, and not finished ones", async () => {
    const { result } = await assign({
      blockedBy: [
        { _id: "b1", taskNumber: 3, title: "open", status: "doing" },
        { _id: "b2", taskNumber: 4, title: "shipped", status: "done" },
      ],
    });

    expect((result as { note: string }).note).toContain("unfinished blockers (BP-3)");
    expect((result as { note: string }).note).not.toContain("BP-4");
  });

  // A person is doing a task with no agent; the board's gaps are beside the point
  it("says only that no agent is named when none is", async () => {
    board({ repositoryUrl: "" });

    const { result } = await assign({ agent: null });
    const note = (result as { note: string }).note;

    expect(note).toContain("no agent is named on it");
    expect(note).not.toContain("repository");
  });
});
