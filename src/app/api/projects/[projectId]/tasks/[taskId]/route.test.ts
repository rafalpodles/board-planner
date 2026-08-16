import { describe, it, expect, vi, beforeEach } from "vitest";

const updateTask = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/task-service", () => ({
  updateTask,
  toApiExecution: (e: unknown) => e,
}));
vi.mock("@/models/task", () => ({ Task: { findOne: vi.fn(), find: vi.fn(), updateMany: vi.fn(), findOneAndDelete: vi.fn() } }));
vi.mock("@/models/comment", () => ({ Comment: { deleteMany: vi.fn() } }));
vi.mock("@/models/activityLog", () => ({ ActivityLog: { deleteMany: vi.fn() } }));
vi.mock("@/models/notification", () => ({ Notification: { deleteMany: vi.fn() } }));
vi.mock("@/models/worker", () => ({ Worker: { find: vi.fn() } }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: { _id: "u1", viaMachineCredential: req.headers.get("x-machine") !== null },
      }),
}));

const { PUT } = await import("./route");

const TASK = "507f1f77bcf86cd799439011";

function request(body: unknown, asMachine = false) {
  return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(asMachine ? { "x-machine": "1" } : {}) },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: TASK }) });

beforeEach(() => {
  vi.clearAllMocks();
  updateTask.mockResolvedValue({ ok: true, data: { _id: TASK } });
});

// BP-320: PATCH .../status refused force from a machine credential; PUT .../tasks/:id reaches the
// identical code path with the identical flag and did not. Same outcome, one door locked.
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
