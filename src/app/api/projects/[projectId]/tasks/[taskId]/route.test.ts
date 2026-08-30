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
          // The role the *request's* principal carries. getAuthUser degrades a scoped token's role
          // to member in memory, so this is where that degradation has to be visible.
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
  // The route reads only the two fields the hold check needs, so the chain is select().lean()
  taskFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ _id: TASK, taskNumber: 7, execution: {} }) }),
  });
  taskDeleteOne.mockResolvedValue({ deletedCount: 1 });
  projectFindById.mockReturnValue({ lean: () => Promise.resolve({ key: "TP" }) });
  heldRunRefusal.mockResolvedValue(null);
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

/**
 * BP-337. Three writers refuse to take a task off a running worker and demand `force`; DELETE was
 * the fourth and asked nothing, while reaching a stronger outcome than any of them — the task is
 * not moved, it is gone, with the comments the run was writing into it.
 */
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
    // Not even asked: forcing is the answer to the question, so the refusal is not computed
    expect(heldRunRefusal).not.toHaveBeenCalled();
  });

  it("refuses force from a machine credential, and does not read the task at all", async () => {
    const res = await DELETE(deleteRequest({ force: true }, true), ctx());

    expect(res.status).toBe(403);
    expect(taskFindOne).not.toHaveBeenCalled();
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });

  /**
   * The control. Without it "refuses held tasks" and "delete is broken" are the same observation,
   * and the ordinary case is the one every board click takes.
   */
  it("still deletes an unheld task, with no body at all on the request", async () => {
    const res = await DELETE(deleteRequest(), ctx());

    expect(res.status).toBe(200);
    expect(taskDeleteOne).toHaveBeenCalledWith({ _id: TASK, project: "p1" });
  });

  /**
   * PUT has this assertion and DELETE did not, which is the BP-320 shape again: `!force` would let
   * `{ force: "yes" }` past the hold check AND past machineMayNotForce, which tests `=== true`.
   */
  it("treats a force that is not literally true as no force at all", async () => {
    heldRunRefusal.mockResolvedValue(HELD);

    const res = await DELETE(deleteRequest({ force: "yes" }), ctx());

    expect(res.status).toBe(409);
    expect(taskDeleteOne).not.toHaveBeenCalled();
  });

  // The ticket's own premise is that the task goes "with the comments the run was writing into
  // it", and nothing asserted that half — before this change or after it
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
