import { describe, it, expect, vi, beforeEach } from "vitest";

const taskFind = vi.fn();
const taskCountDocuments = vi.fn(async () => 0);
const taskFindOne = vi.fn();
const projectFindById = vi.fn();
const assignTaskMock = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind, countDocuments: taskCountDocuments, findOne: taskFindOne } }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/comment", () => ({ Comment: { find: vi.fn(), create: vi.fn() } }));
vi.mock("@/lib/task-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-service")>()),
  assignTask: assignTaskMock,
}));

const { PM_TOOLS } = await import("./tools");

const ctx = {
  projectId: "p1",
  projectKey: "BP",
  pmUserId: "pm",
  triggeredByUserId: "pm",
};

const COLUMNS = [
  { id: "backlog", label: "Backlog", color: "#000", role: "backlog", order: 0 },
  { id: "doing", label: "Doing", color: "#000", role: "active", order: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  projectFindById.mockReturnValue({ lean: async () => ({ columns: COLUMNS }) });
  taskFind.mockReturnValue({
    sort: () => ({ skip: () => ({ limit: () => ({ populate: async () => [] }) }) }),
  });
  taskCountDocuments.mockResolvedValue(0);
});

/**
 * BP-511. The route's status filter was taught to refuse a column id the board has not got, and
 * this tool goes nowhere near the route — it queries Mongo directly. It is also the one surface
 * this product runs unattended, so the empty list the ticket describes ("asked for `todo`, was
 * answered nothing, reported that there was nothing to do") landed here rather than in a chat
 * somebody was reading.
 */
describe("the PM's list_tasks and a column id the board has not got", () => {
  it("refuses it, naming the columns the board does have", async () => {
    const { result } = await PM_TOOLS.list_tasks.execute({ status: "todo" }, ctx);

    expect(result).toMatchObject({ error: expect.stringContaining("project columns: backlog, doing") });
    expect(taskFind, "the query ran anyway").not.toHaveBeenCalled();
  });

  // The control: a tool that refused every filter, or one whose fixture never loaded, would
  // satisfy the assertion above
  it("takes one the board does have", async () => {
    const { result } = await PM_TOOLS.list_tasks.execute({ status: "doing" }, ctx);

    expect(result).not.toHaveProperty("error");
    expect(taskFind).toHaveBeenCalledWith(expect.objectContaining({ status: "doing" }));
  });

  it("leaves an unfiltered listing alone, and asks the board nothing", async () => {
    const { result } = await PM_TOOLS.list_tasks.execute({}, ctx);

    expect(result).not.toHaveProperty("error");
    expect(taskFind.mock.calls[0][0]).not.toHaveProperty("status");
  });

  // It reaches a model as a tool result, so it is not a place to echo an unbounded argument back
  it("does not echo an unbounded status back into the refusal", async () => {
    const { result } = await PM_TOOLS.list_tasks.execute({ status: "x".repeat(5000) }, ctx);

    expect((result as { error: string }).error.length).toBeLessThan(500);
  });
});

/**
 * `assign_task` used to carry its own guard, reporting the damage after the fact — "User 'x' not
 * found — task BP-9 is now unassigned" — because the writer had already cleared the assignee. The
 * writer refuses before writing now, and this is what says the refusal still reaches the model
 * rather than being swallowed on the way.
 */
describe("the PM's assign_task and a username the writer refuses", () => {
  beforeEach(() => {
    taskFindOne.mockResolvedValue({ _id: "t1", taskNumber: 9 });
  });

  it("hands the writer's refusal to the model", async () => {
    assignTaskMock.mockResolvedValue({
      ok: false,
      error: 'No account named "@rafa" — the assignee is a username.',
      status: 400,
    });

    const { result } = await PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: "rafa" }, ctx);

    expect(result).toMatchObject({ error: expect.stringContaining("rafa") });
    // Nothing that reads as a success beside it — the old guard reported the assignment as done
    expect(result).not.toHaveProperty("task");
  });

  it("still reports an assignment the writer accepted", async () => {
    assignTaskMock.mockResolvedValue({
      ok: true,
      data: { taskNumber: 9, assignee: { username: "kuba" } },
    });

    const { result } = await PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: "kuba" }, ctx);

    expect(result).toMatchObject({ task: "BP-9", assignee: "kuba" });
    expect(result).not.toHaveProperty("error");
  });

  it("still unassigns on an explicit null", async () => {
    assignTaskMock.mockResolvedValue({ ok: true, data: { taskNumber: 9, assignee: null } });

    const { result } = await PM_TOOLS.assign_task.execute({ taskKey: "BP-9", username: null }, ctx);

    expect(result).toMatchObject({ task: "BP-9", assignee: null });
  });
});
