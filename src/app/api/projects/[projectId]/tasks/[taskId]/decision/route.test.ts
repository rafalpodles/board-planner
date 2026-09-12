import { describe, it, expect, vi, beforeEach } from "vitest";

const mayDecide = vi.fn();
const recordVerdict = vi.fn();
const logInstanceAudit = vi.fn();
const taskFindOne = vi.fn();
const workerFindById = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/task-decisions", () => ({
  mayDecide,
  recordVerdict,
  toApiDecision: (decision: unknown) => decision,
}));
vi.mock("@/models/task", () => ({ Task: { findOne: taskFindOne } }));
vi.mock("@/models/worker", () => ({ Worker: { findById: workerFindById } }));
// The same shape the status route's mock models: a Bearer is a machine credential, a cookie
// session is a person. Deriving one from the other is what made the hole in BP-336 inexpressible.
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, {
        ...(ctx as object),
        user: {
          _id: "u1",
          username: "owner",
          role: "member",
          viaMachineCredential: (req.headers.get("authorization") ?? "").startsWith("Bearer "),
        },
      }),
}));

const { POST } = await import("./route");

const TASK_ID = "69a52e3b399b27d3cbb2c5b7";
const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";

function decision(over: Record<string, unknown> = {}) {
  return {
    gate: "protected-paths",
    workerId: WORKER_ID,
    commit: "a".repeat(40),
    taskKey: "CP-158",
    files: ["package.json"],
    acceptable: true,
    unacceptableReason: "",
    state: "pending",
    ...over,
  };
}

function call(body: unknown, asMachine = false) {
  return {
    req: new Request(`https://app.example.com/api/projects/p1/tasks/${TASK_ID}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(asMachine ? { authorization: "Bearer cp_x" } : {}),
      },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ projectId: "p1", taskId: TASK_ID }) },
  };
}

function taskWith(value: unknown) {
  taskFindOne.mockReturnValue({
    select: async () => (value === null ? null : { taskNumber: 158, decision: value }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  taskWith(decision());
  mayDecide.mockResolvedValue(true);
  recordVerdict.mockResolvedValue({ ok: true, decision: decision({ state: "accepted" }) });
  workerFindById.mockReturnValue({
    select: () => ({ lean: async () => ({ name: "e2e-macbook-pro", lastSeenAt: new Date() }) }),
  });
});

describe("answering a refused change", () => {
  it.each(["accept", "decline", "abandon"])("records a %s", async (verdict) => {
    const { req, ctx } = call({ verdict });

    expect((await POST(req, ctx)).status).toBe(200);
    expect(recordVerdict).toHaveBeenCalledWith(TASK_ID, verdict, "u1", {
      workerId: WORKER_ID,
      commit: "a".repeat(40),
    });
  });

  /**
   * The same rule `force` follows, and heavier: this runs an agent's change under the machine
   * owner's pinned GitHub identity. An unattended agent must not do that on a person's behalf, and
   * the PM agent is deliberately given no way to name this route at all.
   */
  it("refuses a machine credential outright", async () => {
    const { req, ctx } = call({ verdict: "accept" }, true);

    expect((await POST(req, ctx)).status).toBe(403);
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  it("refuses somebody who is neither the machine's owner nor an instance admin", async () => {
    mayDecide.mockResolvedValue(false);
    const { req, ctx } = call({ verdict: "accept" });

    expect((await POST(req, ctx)).status).toBe(403);
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  /**
   * Read off the record rather than the request: a record the gate marked unacceptable carries a
   * workflow file or a patch that was cut, and neither becomes acceptable because somebody posted
   * the word "accept".
   */
  it("refuses to accept a record the gate marked unacceptable, in its own words", async () => {
    taskWith(decision({ acceptable: false, unacceptableReason: "it edits what CI does" }));
    const { req, ctx } = call({ verdict: "accept" });

    const response = await POST(req, ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "it edits what CI does" });
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  // Declining one is always allowed: the work should not sit on a laptop for ever either way
  it("still lets an unacceptable record be declined", async () => {
    taskWith(decision({ acceptable: false, unacceptableReason: "it edits what CI does" }));
    const { req, ctx } = call({ verdict: "decline" });

    expect((await POST(req, ctx)).status).toBe(200);
    expect(recordVerdict).toHaveBeenCalled();
  });

  /**
   * The route reads the record, resolves the owner and checks `acceptable` before it writes. A
   * second run finishing inside that window replaces a settled record with a different change, so
   * the write has to name the one this request judged rather than "whatever is there now".
   */
  it("names the record it judged, so a replacement cannot inherit the verdict", async () => {
    taskWith(decision({ workerId: "another-machine", commit: "f".repeat(40) }));
    const { req, ctx } = call({ verdict: "accept" });

    await POST(req, ctx);

    expect(recordVerdict).toHaveBeenCalledWith(TASK_ID, "accept", "u1", {
      workerId: "another-machine",
      commit: "f".repeat(40),
    });
  });

  it("refuses a verdict that is not one", async () => {
    const { req, ctx } = call({ verdict: "merge" });

    expect((await POST(req, ctx)).status).toBe(400);
  });

  it("answers 404 for a task that does not exist", async () => {
    taskWith(null);
    const { req, ctx } = call({ verdict: "accept" });

    expect((await POST(req, ctx)).status).toBe(404);
  });

  it("answers 404 for a task with nothing waiting on it", async () => {
    taskWith(undefined);
    const { req, ctx } = call({ verdict: "accept" });

    expect((await POST(req, ctx)).status).toBe(404);
  });

  it("answers the service's refusal when somebody else got there first", async () => {
    recordVerdict.mockResolvedValue({ ok: false, error: "already answered", status: 409 });
    const { req, ctx } = call({ verdict: "accept" });

    expect((await POST(req, ctx)).status).toBe(409);
  });
});

/**
 * Audited at the instance rather than the project, because what accepting spends is the machine
 * owner's pinned GitHub identity and the CI minutes of whatever repository the push lands in —
 * neither of which belongs to the board.
 */
describe("the audit row", () => {
  it.each([
    ["accept", "worker_decision_accepted"],
    ["decline", "worker_decision_declined"],
    ["abandon", "worker_decision_abandoned"],
  ])("names %s as its own action", async (verdict, action) => {
    const { req, ctx } = call({ verdict });
    await POST(req, ctx);

    expect(logInstanceAudit).toHaveBeenCalledWith(expect.objectContaining({ action }));
  });

  it("targets the machine by name, and says which change at which commit", async () => {
    const { req, ctx } = call({ verdict: "accept" });
    await POST(req, ctx);

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "e2e-macbook-pro",
        actorUsername: "owner",
        detail: expect.stringContaining("CP-158 at aaaaaaaaaaaa"),
      })
    );
  });

  it("writes nothing when the verdict was refused", async () => {
    mayDecide.mockResolvedValue(false);
    const { req, ctx } = call({ verdict: "accept" });
    await POST(req, ctx);

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });
});
