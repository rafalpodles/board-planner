import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const workerFind = vi.fn();
const taskFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { find: workerFind } }));
vi.mock("@/models/task", () => ({ Task: { find: taskFind } }));

const { GET } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false };
// The fleet spans every project, so owning one is not a way in
const PROJECT_OWNER = { _id: "owner-1", role: "member", tokenScoped: false };

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

const ownerPopulates: unknown[] = [];

function mockFleet(list: unknown[]) {
  workerFind.mockReturnValue({
    populate: (...args: unknown[]) => {
      ownerPopulates.push(args);
      return { sort: () => Promise.resolve(list) };
    },
  });
}

const sorts: unknown[] = [];
const selects: unknown[] = [];
const populates: unknown[] = [];

function mockRunning(list: unknown[]) {
  taskFind.mockReturnValue({
    sort: (spec: unknown) => {
      sorts.push(spec);
      return {
        select: (fields: unknown) => {
          selects.push(fields);
          return {
            populate: (...args: unknown[]) => {
              populates.push(args);
              return { lean: () => Promise.resolve(list) };
            },
          };
        },
      };
    },
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
  check.mockResolvedValue(false);
  sorts.length = 0;
  selects.length = 0;
  populates.length = 0;
  ownerPopulates.length = 0;
  getAuthUser.mockResolvedValue(ADMIN);
  mockFleet([]);
  mockRunning([]);
});

describe("GET /api/admin/workers", () => {
  it("refuses a project owner", async () => {
    getAuthUser.mockResolvedValue(PROJECT_OWNER);
    check.mockResolvedValue(true);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(workerFind).not.toHaveBeenCalled();
  });

  // BP-358: the owner decides everything a machine may reach, and an ownerless one reaches nothing
  // while looking identical to an idle healthy one. The console cannot show a name the route does
  // not ask for, and an unpopulated ref serialises as a bare id.
  it("asks for the owner's name alongside the fleet", async () => {
    await GET(request(), { params: Promise.resolve({}) });

    expect(ownerPopulates).toEqual([["owner", "username fullName"]]);
  });

  it("names whose machine each one is", async () => {
    mockFleet([
      workerDoc({
        _id: "a1",
        name: "rafal-mac",
        owner: { _id: "u1", username: "rpo", fullName: "Rafal" },
      }),
      workerDoc({ _id: "a2", name: "orphan", owner: null }),
    ]);

    const json = await (await GET(request(), { params: Promise.resolve({}) })).json();

    expect(json.find((w: { name: string }) => w.name === "rafal-mac").owner).toEqual({
      _id: "u1",
      username: "rpo",
      fullName: "Rafal",
    });
    expect(json.find((w: { name: string }) => w.name === "orphan").owner).toBeNull();
  });

  // An id with no name is what an unpopulated ref looks like, and rendering it would put "6a70…"
  // in the column that exists to answer whose machine this is
  it("reports no owner rather than an id when the ref was not populated", async () => {
    mockFleet([workerDoc({ _id: "a1", name: "unpopulated", owner: "6a732075133f935b19154cd2" })]);

    const json = await (await GET(request(), { params: Promise.resolve({}) })).json();

    expect(json[0].owner).toBeNull();
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

  // A worker killed mid-run leaves its task claimed until the lease is swept, so the same worker
  // can match an abandoned task and the one it is really running. Without an order the server
  // decides, and it can settle on the dead one — reporting work the worker gave up hours ago.
  it("prefers the newest claim when a worker matches more than one task", async () => {
    mockFleet([workerDoc({ _id: "a1" })]);
    mockRunning([runningTask("a1")]);

    await GET(request(), { params: Promise.resolve({}) });

    expect(sorts[0]).toEqual({ "execution.startedAt": -1 });
  });

  // The projection and the populate path are invisible to this mock, so they are asserted rather
  // than exercised: dropping project from the select would degrade every taskKey to "?-161" in
  // production while every test here stayed green.
  it("asks for the fields the task key is built from", async () => {
    mockFleet([workerDoc({ _id: "a1" })]);
    mockRunning([runningTask("a1")]);

    await GET(request(), { params: Promise.resolve({}) });

    expect(String(selects[0])).toContain("project");
    expect(populates[0]).toEqual(["project", "key"]);
  });

  it("scopes the query to the fleet it was given", async () => {
    mockFleet([workerDoc({ _id: "a1" })]);
    mockRunning([runningTask("a1")]);

    await GET(request(), { params: Promise.resolve({}) });

    expect(taskFind.mock.calls[0][0]["execution.workerId"]).toEqual({ $in: ["a1"] });
  });
});
