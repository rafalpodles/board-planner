import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const touchWorker = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential, touchWorker };
});

const { POST } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const PROJECT_ID = "69a52e3b399b27d3cbb2c5b7";

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKER_ID,
    enabled: true,
    lockedByInstance: false,
    version: "1.0.0",
    policy: { baseBranch: "main" },
    assignments: [{ project: PROJECT_ID, proposedPath: "/repo" }],
    command: "",
    commandIssuedAt: null,
    ...overrides,
  };
}

function request(body: unknown = {}) {
  return {
    req: new Request(`http://localhost/api/workers/${WORKER_ID}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cpw_secret",
        "x-worker-id": WORKER_ID,
        "x-cp-protocol": "1",
      },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ workerId: WORKER_ID }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyWorkerCredential.mockResolvedValue(workerDoc());
  touchWorker.mockResolvedValue(undefined);
});

describe("POST /api/workers/:workerId/heartbeat", () => {
  // The one channel that survives SSE loss and a restart: the worker applies what this says,
  // and keys "already applied" on the issuance
  it("carries the standing command and its issuance", async () => {
    verifyWorkerCredential.mockResolvedValue(
      workerDoc({ command: "pause", commandIssuedAt: new Date("2026-08-01T12:00:00.000Z") })
    );
    const { req, ctx } = request();

    const response = await POST(req, ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.command).toBe("pause");
    expect(json.commandIssuedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("reports no issuance when no command has ever been issued", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.command).toBe("");
    expect(json.commandIssuedAt).toBeNull();
  });

  it("refuses a disabled worker with the abort verdict instead of a command", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ enabled: false, command: "pause" }));
    const { req, ctx } = request();

    const response = await POST(req, ctx);

    expect(response.status).toBe(403);
    expect((await response.json()).abort).toBe(true);
    expect(touchWorker).not.toHaveBeenCalled();
  });

  it("returns the policy and assignments the worker refreshes from", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.policy).toEqual({ baseBranch: "main" });
    expect(json.assignments).toEqual([{ project: PROJECT_ID, proposedPath: "/repo" }]);
  });
});
