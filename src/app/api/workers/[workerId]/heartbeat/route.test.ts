import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWorkerCredential = vi.fn();
const touchWorker = vi.fn();

const projectFind = vi.fn();
const workerUpdateOne = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({
  Project: { find: () => ({ select: () => ({ lean: projectFind }) }) },
}));
vi.mock("@/models/worker", () => ({ Worker: { updateOne: workerUpdateOne } }));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential, touchWorker };
});

const { POST } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const PROJECT_ID = "69a52e3b399b27d3cbb2c5b7";
const REMOTE = "git@github.com:owner/repo.git";

function enabledProject() {
  return {
    _id: PROJECT_ID,
    githubRepo: "owner/repo",
    worker: { enabled: true, policy: { autoMerge: true }, policyOverrides: ["autoMerge"] },
  };
}

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: WORKER_ID,
    enabled: true,
    lockedByInstance: false,
    version: "1.0.0",
    policy: { pollIntervalMs: 5000 },
    policyOverrides: ["pollIntervalMs"],
    repos: [{ remote: REMOTE, path: "/repo" }],
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
  projectFind.mockResolvedValue([enabledProject()]);
  workerUpdateOne.mockResolvedValue({});
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

  // Only the fields an operator set. A worker that is handed the whole stored policy pins every
  // field forever, because the schema materialises a default into each one at creation — so a
  // later change to a default would never reach it.
  it("returns the machine's own pinned settings, and nothing else", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.policy).toEqual({ pollIntervalMs: 5000 });
  });

  it("sends nothing when the operator pinned nothing on this machine", async () => {
    verifyWorkerCredential.mockResolvedValue(workerDoc({ policyOverrides: [] }));
    const { req, ctx } = request();

    expect((await (await POST(req, ctx)).json()).policy).toEqual({});
  });

  // The whole inversion in one assertion: a remote comes back, never a path.
  it("answers with assignments keyed by remote, carrying the project's own policy", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(json.assignments).toEqual([
      { project: PROJECT_ID, remote: REMOTE, policy: { autoMerge: true } },
    ]);
  });

  it("offers nothing for a project nobody enabled for workers", async () => {
    projectFind.mockResolvedValue([
      { ...enabledProject(), worker: { enabled: false, policy: {}, policyOverrides: [] } },
    ]);
    const { req, ctx } = request();

    expect((await (await POST(req, ctx)).json()).assignments).toEqual([]);
  });

  it("stores what the worker reported so the fleet console can show it", async () => {
    const reported = [{ remote: REMOTE, path: "/somewhere" }];
    const { req, ctx } = request({ repos: reported });

    await POST(req, ctx);

    expect(workerUpdateOne).toHaveBeenCalledWith(
      { _id: WORKER_ID },
      { $set: { repos: reported } }
    );
  });

  // An older worker that does not report yet must keep the inventory it already has, or it would
  // silently lose every project the moment it heartbeats.
  it("keeps the stored inventory when a heartbeat carries none", async () => {
    const { req, ctx } = request();

    const json = await (await POST(req, ctx)).json();

    expect(workerUpdateOne).not.toHaveBeenCalled();
    expect(json.assignments).toHaveLength(1);
  });
});
