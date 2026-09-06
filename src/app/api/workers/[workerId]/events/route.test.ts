import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const updateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { updateOne } }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential };
});

const { POST } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const TASK_ID = "69a52e3b399b27d3cbb2c5b7";

const authed = {
  "content-type": "application/json",
  authorization: "Bearer cpw_secret",
  "x-worker-id": WORKER_ID,
  "x-cp-protocol": "1",
};

function request(headers: Record<string, string>, body: unknown) {
  return {
    req: new Request(`http://localhost/api/workers/${WORKER_ID}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ workerId: WORKER_ID }) },
  };
}

const event = { taskId: TASK_ID, runId: "run-1", seq: 1, phase: "gates:build" };

function workerDoc(overrides: Record<string, unknown> = {}) {
  return { _id: WORKER_ID, credentialHash: "h", enabled: true, lockedByInstance: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyWorkerCredential.mockResolvedValue(workerDoc());
  updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

describe("POST /api/workers/:workerId/events", () => {
  it.each([
    ["disabled", { enabled: false }],
    ["locked by the instance", { lockedByInstance: true }],
  ])("refuses a worker that is %s, without touching a task", async (_label, overrides) => {
    verifyWorkerCredential.mockResolvedValue(workerDoc(overrides));
    const { req, ctx } = request(authed, event);

    const response = await POST(req, ctx);

    expect(response.status).toBe(403);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller without touching a task", async () => {
    const { req, ctx } = request({ "content-type": "application/json" }, event);

    const response = await POST(req, ctx);

    expect(response.status).toBe(401);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("refuses a credential that names a different worker than the path", async () => {
    const { req } = request(authed, event);

    const response = await POST(req, {
      params: Promise.resolve({ workerId: "69a52e3b399b27d3cbb2c5c9" }),
    });

    expect(response.status).toBe(403);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("records the phase against the run that holds the task", async () => {
    const { req, ctx } = request(authed, event);

    const response = await POST(req, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter._id).toBe(TASK_ID);
    expect(filter["execution.workerId"]).toBe(WORKER_ID);
    expect(filter["execution.runId"]).toBe("run-1");
    expect(update.$set["execution.phase"]).toBe("gates:build");
    expect(update.$set["execution.phaseSeq"]).toBe(1);
    expect(update.$set["execution.phaseAt"]).toBeInstanceOf(Date);
  });

  it("takes the worker identity from the credential, never from the body", async () => {
    const { req, ctx } = request(authed, { ...event, workerId: "69a52e3b399b27d3cbb2c5c9" });

    await POST(req, ctx);

    expect(updateOne.mock.calls[0][0]["execution.workerId"]).toBe(WORKER_ID);
  });

  it("reports that nothing was written when the run no longer holds the task", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const { req, ctx } = request(authed, event);

    const response = await POST(req, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: false });
  });

  it("rejects a malformed event without touching a task", async () => {
    const cases: Array<[string, unknown]> = [
      ["missing taskId", { ...event, taskId: undefined }],
      ["a taskId that is not an id", { ...event, taskId: "not-an-id" }],
      ["missing runId", { ...event, runId: "" }],
      ["a non-numeric seq", { ...event, seq: "1" }],
      ["a fractional seq", { ...event, seq: 1.5 }],
      ["a seq of zero", { ...event, seq: 0 }],
      ["a negative seq", { ...event, seq: -1 }],
      ["a blank phase", { ...event, phase: "   " }],
      ["a phase that is not a string", { ...event, phase: { name: "Edit" } }],
      ["a phase longer than a badge", { ...event, phase: "x".repeat(121) }],
      ["a phase carrying an ansi escape", { ...event, phase: "agent\u001b[2Kwipe" }],
      ["a phase carrying a newline", { ...event, phase: "agent\nwipe" }],
    ];

    for (const [name, body] of cases) {
      const { req, ctx } = request(authed, body);
      const response = await POST(req, ctx);
      expect(response.status, name).toBe(400);
    }

    expect(updateOne).not.toHaveBeenCalled();
  });

  it("survives a body that is not an object at all", async () => {
    const { req, ctx } = request(authed, null);

    const response = await POST(req, ctx);

    expect(response.status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
