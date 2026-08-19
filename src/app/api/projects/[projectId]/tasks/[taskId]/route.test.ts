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


/**
 * BP-345 had this route work out whether the caller could choose a task's agent and pass the answer
 * down, because choosing one could then arm a machine belonging to somebody else. BP-358 moved that
 * boundary into the claim — a machine takes only what its own owner assigned to themselves — and
 * the choice went back to whoever may edit the task, which `withProjectAccess` already answers.
 *
 * Asserted on the whole argument list rather than on a role: what changed is that the route stopped
 * having an opinion, and a test naming one index could not tell "false" from "gone".
 */
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

  // A scoped token's role is degraded to member in memory by getAuthUser, and the route no longer
  // reads it at all — so the two requests above have to be indistinguishable here, not merely both
  // permitted
  it("says the same thing whoever asks", async () => {
    await PUT(roleOf("member"), ctx());
    await PUT(roleOf("admin"), ctx());

    expect(updateTask.mock.calls[0]).toEqual(updateTask.mock.calls[1]);
  });
});
