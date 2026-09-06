import { describe, it, expect, vi, beforeEach } from "vitest";

const updateTask = vi.fn();
const heldRunRefusal = vi.fn();
const taskFindOne = vi.fn();
const taskDeleteOne = vi.fn();
const projectFindById = vi.fn();
const commentDeleteMany = vi.fn();
const activityDeleteMany = vi.fn();
const notificationDeleteMany = vi.fn();
const taskUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({
  updateTask,
  heldRunRefusal,
  toApiExecution: (e: unknown) => e,
  taskPopulateFields: [],
}));
vi.mock("@/models/task", () => ({
  Task: { findOne: taskFindOne, find: vi.fn(), updateMany: taskUpdateMany, deleteOne: taskDeleteOne, findOneAndDelete: vi.fn() },
}));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/comment", () => ({ Comment: { deleteMany: commentDeleteMany } }));
vi.mock("@/models/activityLog", () => ({ ActivityLog: { deleteMany: activityDeleteMany } }));
vi.mock("@/models/notification", () => ({ Notification: { deleteMany: notificationDeleteMany } }));
vi.mock("@/models/worker", () => ({ Worker: { find: vi.fn() } }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: {
          _id: "u1",
          role: req.headers.get("x-role") ?? "member",
          viaMachineCredential: req.headers.get("x-machine") !== null,
        },
      }),
}));

const { PUT, DELETE } = await import("./route");

const TASK = "507f1f77bcf86cd799439011";

function request(body: unknown, asMachine = false) {
  return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(asMachine ? { "x-machine": "1" } : {}) },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: TASK }) });

function deleteRequest(body?: unknown, asMachine = false) {
  return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(asMachine ? { "x-machine": "1" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const HELD = {
  ok: false as const,
  error: "TP-7 is being executed by mac (phase agent). Stop the worker, or move it anyway.",
  status: 409,
  runConflict: { workerId: "w1", workerName: "mac", phase: "agent", phaseAt: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  updateTask.mockResolvedValue({ ok: true, data: { _id: TASK } });
  taskFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ _id: TASK, taskNumber: 7, execution: {} }) }),
  });
  taskDeleteOne.mockResolvedValue({ deletedCount: 1 });
  projectFindById.mockReturnValue({ lean: () => Promise.resolve({ key: "TP" }) });
  heldRunRefusal.mockResolvedValue(null);
});

describe("PUT .../tasks/:taskId and force", () => {
  it("refuses force from a machine credential", async () => {
    const res = await PUT(request({ status: "done", force: true }, true), ctx());

    expect(res.status).toBe(403);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("lets a person force, which is how the board takes a task back", async () => {
    const res = await PUT(request({ status: "done", force: true }), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { status: "done" }, "u1", true);
  });

  it("still lets a machine credential make an ordinary edit", async () => {
    const res = await PUT(request({ title: "renamed" }, true), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { title: "renamed" }, "u1", false);
  });

  it("does not treat a non-true force as a force", async () => {
    const res = await PUT(request({ status: "done", force: "yes" }, true), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { status: "done" }, "u1", false);
  });
});

describe("PUT .../tasks/:taskId and the agent", () => {
  const AGENT = "69a52e3b399b27d3cbb2c5a5";

  beforeEach(() => {
    vi.clearAllMocks();
    updateTask.mockResolvedValue({ ok: true, data: { _id: TASK } });
  });

  function roleOf(role: string) {
    return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-role": role },
      body: JSON.stringify({ agent: AGENT }),
    });
  }

  it.each(["member", "admin"])("passes a %s's choice straight through", async (role) => {
    const res = await PUT(roleOf(role), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { agent: AGENT }, "u1", false);
  });

  it("says the same thing whoever asks", async () => {
    await PUT(roleOf("member"), ctx());
    await PUT(roleOf("admin"), ctx());

    expect(updateTask.mock.calls[0]).toEqual(updateTask.mock.calls[1]);
  });
});

describe("DELETE .../tasks/:taskId and the run hold", () => {
  it("refuses a task a run holds, with the 409 shape the other writers give", async () => {
    heldRunRefusal.mockResolvedValue(HELD);

    const res = await DELETE(deleteRequest(), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).runConflict).toMatchObject({ workerName: "mac", phase: "agent" });
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });

  it("deletes when a person forces, which is what the dialog resends", async () => {
    heldRunRefusal.mockResolvedValue(HELD);

    const res = await DELETE(deleteRequest({ force: true }), ctx());

    expect(res.status).toBe(200);
    expect(taskDeleteOne).toHaveBeenCalled();
    expect(heldRunRefusal).not.toHaveBeenCalled();
  });

  it("refuses force from a machine credential, and does not read the task at all", async () => {
    const res = await DELETE(deleteRequest({ force: true }, true), ctx());

    expect(res.status).toBe(403);
    expect(taskFindOne).not.toHaveBeenCalled();
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });

  it("still deletes an unheld task, with no body at all on the request", async () => {
    const res = await DELETE(deleteRequest(), ctx());

    expect(res.status).toBe(200);
    expect(taskDeleteOne).toHaveBeenCalledWith({ _id: TASK, project: "p1" });
  });

  it("treats a force that is not literally true as no force at all", async () => {
    heldRunRefusal.mockResolvedValue(HELD);

    const res = await DELETE(deleteRequest({ force: "yes" }), ctx());

    expect(res.status).toBe(409);
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });

  it("takes the comments, activity, notifications and inbound links with it", async () => {
    await DELETE(deleteRequest(), ctx());

    expect(commentDeleteMany).toHaveBeenCalledWith({ task: TASK });
    expect(activityDeleteMany).toHaveBeenCalledWith({ task: TASK });
    expect(notificationDeleteMany).toHaveBeenCalledWith({ task: TASK });
    expect(taskUpdateMany).toHaveBeenCalledWith({ blockedBy: TASK }, { $pull: { blockedBy: TASK } });
  });

  it("still answers 404 for a task that is not there, rather than reading it as held", async () => {
    taskFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    const res = await DELETE(deleteRequest(), ctx());

    expect(res.status).toBe(404);
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });
});
