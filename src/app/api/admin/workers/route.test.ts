import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const workerFind = vi.fn();
const taskFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/worker", () => ({ Worker: { find: workerFind } }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));

const { GET } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false, allowedProjects: [] };
const MEMBER = { _id: "member-1", role: "member", tokenScoped: false, allowedProjects: [] };

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "69a52e3b399b27d3cbb2c5a5",
    name: "laptop-1",
    host: "mac.local",
    platform: "darwin",
    version: "1.0.0",
    protocolVersion: 1,
    assignments: [],
    policy: {
      baseBranch: "main",
      pollIntervalMs: 30_000,
      taskTimeoutMs: 1_800_000,
      maxDiffLines: 400,
      maxDiffFiles: 10,
      model: "opus",
    },
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date(),
    bindingError: "",
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date(),
    credentialHash: "should-never-reach-the-client",
    ...overrides,
  };
}

function request() {
  return new Request("http://localhost/api/admin/workers");
}

function mockFleet(list: unknown[]) {
  workerFind.mockReturnValue({ sort: () => Promise.resolve(list) });
}

function mockRunning(list: unknown[]) {
  taskFind.mockReturnValue({
    select: () => ({ populate: () => ({ lean: () => Promise.resolve(list) }) }),
  });
}

function runningTask(workerId: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: "69a52e3b399b27d3cbb2c5b7",
    taskNumber: 161,
    title: "Worker control plane",
    project: { key: "CP" },
    execution: {
      workerId,
      runId: "run-1",
      phase: "gates:build",
      phaseAt: new Date("2026-08-03T12:00:00.000Z"),
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  mockFleet([]);
  mockRunning([]);
});

describe("GET /api/admin/workers", () => {
  it("refuses a non-admin", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(workerFind).not.toHaveBeenCalled();
  });

  it("lists the fleet with credentialHash stripped and staleness derived", async () => {
    const fresh = workerDoc({ _id: "a1", name: "fresh-worker", lastSeenAt: new Date() });
    const stale = workerDoc({
      _id: "a2",
      name: "stale-worker",
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    mockFleet([fresh, stale]);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toHaveLength(2);
    expect(json.every((w: Record<string, unknown>) => !("credentialHash" in w))).toBe(true);
    expect(json.find((w: { name: string }) => w.name === "fresh-worker").stale).toBe(false);
    expect(json.find((w: { name: string }) => w.name === "stale-worker").stale).toBe(true);
  });

  // Phase lives on the task, so a worker document alone cannot answer "what is it doing" — the
  // route has to join, and the fleet console has nothing to render without it
  it("reports the task a worker is running, with its phase", async () => {
    mockFleet([workerDoc({ _id: "a1", name: "busy" })]);
    mockRunning([runningTask("a1")]);

    const response = await GET(request(), { params: Promise.resolve({}) });
    const [worker] = await response.json();

    expect(worker.currentTask).toEqual({
      taskId: "69a52e3b399b27d3cbb2c5b7",
      taskKey: "CP-161",
      title: "Worker control plane",
      phase: "gates:build",
      phaseAt: "2026-08-03T12:00:00.000Z",
    });
  });

  it("reports a claimed task that has not filed a phase yet", async () => {
    mockFleet([workerDoc({ _id: "a1", name: "busy" })]);
    mockRunning([runningTask("a1", { execution: { workerId: "a1", runId: "run-1" } })]);

    const response = await GET(request(), { params: Promise.resolve({}) });
    const [worker] = await response.json();

    expect(worker.currentTask.taskKey).toBe("CP-161");
    expect(worker.currentTask.phase).toBeUndefined();
    expect(worker.currentTask.phaseAt).toBeNull();
  });

  it("leaves an idle worker without a task rather than borrowing someone else's", async () => {
    mockFleet([workerDoc({ _id: "a1", name: "idle" })]);
    mockRunning([runningTask("a2")]);

    const response = await GET(request(), { params: Promise.resolve({}) });
    const [worker] = await response.json();

    expect(worker.currentTask).toBeUndefined();
  });

  it("does not query for tasks when the fleet is empty", async () => {
    mockFleet([]);

    await GET(request(), { params: Promise.resolve({}) });

    expect(taskFind).not.toHaveBeenCalled();
  });

  // Every exit from the active column clears the run identity, so a task with no runId is not being
  // run by anyone — asking for one is what keeps a finished task off the console
  it("only asks for tasks whose run identity is still set", async () => {
    mockFleet([workerDoc({ _id: "a1" })]);

    await GET(request(), { params: Promise.resolve({}) });

    expect(taskFind.mock.calls[0][0]["execution.runId"]).toEqual({ $nin: [null, ""] });
  });
});
