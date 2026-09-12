import { describe, it, expect, vi, beforeEach } from "vitest";

const mayDecide = vi.fn();
const recordVerdict = vi.fn();
const logInstanceAudit = vi.fn();
const taskFindOne = vi.fn();
const workerFindById = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
// Every argument kept, not just the record: `canDecide` is the third, and the panel hides every
// button when it is false — so a mock that drops it cannot see the route answering `false` right
// after a verdict.
const toApiDecision = vi.fn((decision: unknown, worker: unknown, canDecide: unknown) => ({
  decision,
  worker,
  canDecide,
}));
vi.mock("@/lib/task-decisions", () => ({ mayDecide, recordVerdict, toApiDecision }));
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

const { GET, POST } = await import("./route");

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

/** What a route asked mongoose to project, off the query the mock handed it. */
function selectedBy(find: typeof taskFindOne): unknown {
  return find.mock.results[0].value.select.mock.calls[0][0];
}

function taskWith(value: unknown) {
  const answer = value === null ? null : { taskNumber: 158, decision: value };
  taskFindOne.mockReturnValue({
    select: vi.fn(() => ({
      // The verdict route awaits the select; the GET chains a populate onto it
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve),
      populate: async () => answer,
    })),
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

  /**
   * The caller just answered it, so they may obviously answer it — and the panel reads `canDecide`
   * to decide whether to render a button at all. Answering false here hides every control on the
   * record the person is looking at until they reload.
   */
  it("tells the answer it returns that this reader may decide", async () => {
    const { req, ctx } = call({ verdict: "accept" });
    await POST(req, ctx);

    expect(toApiDecision.mock.calls[0][2]).toBe(true);
  });

  /**
   * The bar is the machine that holds the work, not the task and not the caller. The e2e cannot
   * see this — the fixture has one worker, so "the machine's owner" and "any worker id" are the
   * same answer there.
   */
  it("asks about the machine named on the record, not about anything else", async () => {
    taskWith(decision({ workerId: "6a70afff45d39cd9bc8bb601" }));
    const { req, ctx } = call({ verdict: "accept" });

    await POST(req, ctx);

    expect(mayDecide).toHaveBeenCalledWith(
      "6a70afff45d39cd9bc8bb601",
      expect.objectContaining({ _id: "u1" })
    );
  });

  // A task in another project must not be answerable through this one's path
  it("looks the task up inside the project the path names", async () => {
    const { req, ctx } = call({ verdict: "accept" });
    await POST(req, ctx);

    expect(taskFindOne).toHaveBeenCalledWith({ _id: TASK_ID, project: "p1" });
  });

  /**
   * The same trap as the GET below: `.select("taskNumber decision")` is a parent INCLUSION, so
   * mongoose sends `{decision: 1}`, the `select: false` on the subfields is overridden, and up to
   * 220 KB of patch is read on every verdict — while the schema's comment says the two readers
   * that want it say so.
   */
  it("reads only the fields the verdict rests on, not the whole subdocument", async () => {
    const { req, ctx } = call({ verdict: "accept" });
    await POST(req, ctx);

    const named = String(selectedBy(taskFindOne)).split(/\s+/).filter(Boolean);

    expect(named).not.toContain("decision");
    for (const field of ["workerId", "commit", "acceptable", "gate", "files"]) {
      expect(named).toContain(`decision.${field}`);
    }
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

/**
 * The panel polls this while a verdict is with the machine. The task-detail route it would
 * otherwise re-read selects `+decision.patch` — up to 220 KB every ten seconds, per open tab, for
 * exactly as long as the machine never settles.
 */
describe("reading what is waiting", () => {
  /**
   * Named field by field, and `not.toContain("+decision.patch")` is NOT enough to pin that: a bare
   * `.select("decision")` is a parent INCLUSION — mongoose sends `{decision: 1}`, which overrides
   * the `select: false` on the subfields and brings the whole patch with it — and it contains no
   * `+decision.patch` either. So the projection is read for what it names.
   */
  it("names the fields it wants, rather than the subdocument that holds them", async () => {
    const { req, ctx } = call({});
    await GET(req, ctx);

    const selected = String(selectedBy(taskFindOne));
    const named = selected.split(/\s+/).filter(Boolean);

    expect(named).not.toContain("decision");
    expect(named).not.toContain("+decision.patch");
    // The fields the panel actually renders, so the projection cannot be narrowed into uselessness
    for (const field of ["state", "gate", "commit", "prUrl", "error", "acceptable", "files"]) {
      expect(named).toContain(`decision.${field}`);
    }
  });

  it("answers null for a task with nothing waiting on it", async () => {
    taskWith(undefined);
    const { req, ctx } = call({});

    const response = await GET(req, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: null });
  });

  // Asserted on what the route hands the serialiser rather than on what the mock hands back: the
  // mock reshapes, so reading its output would be reading the test's own fixture
  it("serialises the record with the machine and the reader's standing", async () => {
    const { req, ctx } = call({});
    await GET(req, ctx);

    const [record, worker, canDecide] = toApiDecision.mock.calls[0];
    expect(record).toMatchObject({ state: "pending", workerId: WORKER_ID });
    expect(worker).toMatchObject({ name: "e2e-macbook-pro" });
    expect(canDecide).toBe(true);
  });

  it("says the reader may not answer when they may not", async () => {
    mayDecide.mockResolvedValue(false);
    const { req, ctx } = call({});
    await GET(req, ctx);

    expect(toApiDecision.mock.calls[0][2]).toBe(false);
  });

  it("looks the task up inside the project the path names", async () => {
    const { req, ctx } = call({});
    await GET(req, ctx);

    expect(taskFindOne).toHaveBeenCalledWith({ _id: TASK_ID, project: "p1" });
  });
});
