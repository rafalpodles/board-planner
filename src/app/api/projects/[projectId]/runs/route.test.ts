import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findOne = vi.fn();
const taskExists = vi.fn();
const declaredReach: unknown[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/agentRun", () => ({ AgentRun: { create, findOne } }));
vi.mock("@/models/task", () => ({ Task: { exists: taskExists } }));
vi.mock("@/models/agent", () => ({ Agent: { findById: () => ({ lean: async () => null }) } }));
vi.mock("@/lib/agent-service", () => ({ toApiRun: (run: unknown) => run }));
// `workerId` is what the real middleware sets ONLY after verifying the credential against exactly
// that id, and leaves unset on the person branch. Both are driven below; `beforeEach` puts it back
// to a verified machine.
let callingWorker: string | undefined;

vi.mock("@/lib/middleware", () => ({
  withProjectAccessOrWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>, options?: unknown) => {
      declaredReach.push(options);
      return (req: Request, ctx: unknown) =>
        handler(req, {
          ...(ctx as object),
          user: { _id: "u1", viaMachineCredential: false },
          workerId: callingWorker,
        });
    },
}));

const { POST } = await import("./route");

const TASK_ID = "6aa5093477594ac4be8677e6";
const WORKER_ID = "6aa5093477594ac4be8677e7";
const OTHER_WORKER_ID = "6aa5093477594ac4be8677e8";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("https://app.example.com/api/projects/p1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "failed", taskId: TASK_ID, taskKey: "BP-1", ...body }),
    }),
    { params: Promise.resolve({ projectId: "p1" }) }
  );
}

const stored = () => create.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  callingWorker = WORKER_ID;
  taskExists.mockResolvedValue(true);
  create.mockImplementation(async (doc: unknown) => ({ toObject: () => doc }));
  findOne.mockReturnValue({ lean: async () => null });
});

// BP-620: the route is withProjectAccessOrWorker, so any member of the project can POST these
// fields directly; only `detail` was bounded on the way in.
describe("POST .../runs bounds what a caller can store", () => {
  it("cuts refusedBy at the length it cuts detail at", async () => {
    const res = await post({ refusedBy: "g".repeat(5000), detail: "d".repeat(5000) });

    expect(res.status).toBe(201);
    expect(stored().refusedBy).toHaveLength(2000);
    expect(stored().detail).toHaveLength(2000);
  });

  it("cuts the key and the agent's name, which a member posts as freely", async () => {
    await post({ taskKey: "K".repeat(900), agentName: "A".repeat(900) });

    expect(stored().taskKey).toHaveLength(200);
    expect(stored().agentName).toHaveLength(200);
  });

  it("keeps an ordinary report whole", async () => {
    await post({ refusedBy: "diff-size", agentName: "Ship it", detail: "3 files, 40 lines" });

    expect(stored()).toMatchObject({
      refusedBy: "diff-size",
      agentName: "Ship it",
      detail: "3 files, 40 lines",
      taskKey: "BP-1",
    });
  });

  it("stores no worker rather than handing mongoose something to choke on", async () => {
    callingWorker = "not-an-id";

    await post({});

    expect(stored().worker).toBeNull();
  });

  it("still records the worker that sent the report", async () => {
    await post({});

    expect(stored().worker).toBe(WORKER_ID);
  });

  // A member of the project can POST this route directly. The machine is the one the credential
  // proved, so a body naming somebody else's does not reach the fleet screen (found in review).
  it("refuses a machine a person named in the body", async () => {
    callingWorker = undefined;

    await post({ workerId: OTHER_WORKER_ID, outcome: "machineFault" });

    expect(stored().worker).toBeNull();
  });

  it("does not let a machine report as another one either", async () => {
    callingWorker = WORKER_ID;

    await post({ workerId: OTHER_WORKER_ID });

    expect(stored().worker).toBe(WORKER_ID);
  });
});

// BP-758: the record goes out from the outbox, which resends anything it never saw acknowledged
describe("POST .../runs keeps one record per run", () => {
  const RUN_ID = "0f8c1e5a-7d7b-4c43-9a55-3f1f5f0f2a11";

  // What proves the record is the caller's own lives in the middleware; the route has to ask for it
  it("is guarded as a run record, not as a project route", () => {
    expect(declaredReach).toContainEqual({ reach: "runRecord" });
  });

  it("stores the run id a machine's record carries", async () => {
    const res = await post({ runId: RUN_ID });

    expect(res.status).toBe(201);
    expect(stored().runId).toBe(RUN_ID);
  });

  it("answers a resent record with the one already stored and writes nothing", async () => {
    findOne.mockReturnValue({ lean: async () => ({ _id: "r1", runId: RUN_ID }) });

    const res = await post({ runId: RUN_ID });

    expect(res.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ task: TASK_ID, runId: RUN_ID });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers the loser of two concurrent sends with the winner's record", async () => {
    findOne
      .mockReturnValueOnce({ lean: async () => null })
      .mockReturnValueOnce({ lean: async () => ({ _id: "r1", runId: RUN_ID }) });
    create.mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));

    const res = await post({ runId: RUN_ID });

    expect(res.status).toBe(200);
  });

  it("still fails a write that failed for any other reason", async () => {
    create.mockRejectedValue(new Error("connection reset"));

    await expect(post({ runId: RUN_ID })).rejects.toThrow("connection reset");
  });

  // A member could otherwise store a run's id first, and the machine's real record would then be
  // answered with theirs
  it("takes no run id from a person", async () => {
    callingWorker = undefined;

    await post({ runId: RUN_ID });

    expect(stored().runId).toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });
});
