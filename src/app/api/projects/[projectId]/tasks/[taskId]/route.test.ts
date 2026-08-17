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
        user: {
          _id: "u1",
          // The role the *request's* principal carries. getAuthUser degrades a scoped token's role
          // to member in memory, so this is where that degradation has to be visible.
          role: req.headers.get("x-role") ?? "member",
          viaMachineCredential: req.headers.get("x-machine") !== null,
        },
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
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { status: "done" }, "u1", true, false);
  });

  it("still lets a machine credential make an ordinary edit", async () => {
    const res = await PUT(request({ title: "renamed" }, true), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { title: "renamed" }, "u1", false, false);
  });

  it("does not treat a non-true force as a force", async () => {
    const res = await PUT(request({ status: "done", force: "yes" }, true), ctx());

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith("p1", TASK, { status: "done" }, "u1", false, false);
  });
});


/**
 * The route decides whether the caller may choose a task's agent, because only it holds the live
 * principal. updateTask used to work it out by reloading the actor from Mongo, which drops
 * tokenScoped/tokenScope and the role a scoped token was degraded to — so an admin's
 * project-scoped CI token was handed the one capability its scope existed to withhold (BP-345).
 */
describe("PUT .../tasks/:taskId and who may choose the agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTask.mockResolvedValue({ ok: true, data: { _id: TASK } });
  });

  function roleOf(role: string) {
    return new Request(`https://app.example.com/api/projects/p1/tasks/${TASK}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-role": role },
      body: JSON.stringify({ agent: "69a52e3b399b27d3cbb2c5a5" }),
    });
  }

  it("withholds it from a member", async () => {
    await PUT(roleOf("member"), ctx());

    expect(updateTask.mock.calls[0][5]).toBe(false);
  });

  it("grants it to an instance admin", async () => {
    await PUT(roleOf("admin"), ctx());

    expect(updateTask.mock.calls[0][5]).toBe(true);
  });

  // The exploit a reviewer drove: an admin mints a token scoped to one project, whose documented
  // contract is member-level on it. getAuthUser degrades the role; reading it here honours that,
  // and reloading the user from the database would not.
  it("withholds it from an admin's project-scoped token, whose role is degraded to member", async () => {
    await PUT(roleOf("member"), ctx());

    expect(updateTask.mock.calls[0][5]).toBe(false);
  });
});
