import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const taskExists = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/agentRun", () => ({ AgentRun: { create } }));
vi.mock("@/models/task", () => ({ Task: { exists: taskExists } }));
vi.mock("@/models/agent", () => ({ Agent: { findById: () => ({ lean: async () => null }) } }));
vi.mock("@/lib/agent-service", () => ({ toApiRun: (run: unknown) => run }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccessOrWorker:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "u1", viaMachineCredential: false } }),
}));

const { POST } = await import("./route");

const TASK_ID = "6aa5093477594ac4be8677e6";
const WORKER_ID = "6aa5093477594ac4be8677e7";

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
  taskExists.mockResolvedValue(true);
  create.mockImplementation(async (doc: unknown) => ({ toObject: () => doc }));
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
    await post({ workerId: "not-an-id" });

    expect(stored().worker).toBeNull();
  });

  it("still records the worker that sent the report", async () => {
    await post({ workerId: WORKER_ID });

    expect(stored().worker).toBe(WORKER_ID);
  });
});
