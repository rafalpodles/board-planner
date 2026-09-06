import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const runFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/models/agentRun", () => ({ AgentRun: { find: runFind } }));

const { GET } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", viaMachineCredential: false };
const MEMBER = { _id: "member-1", role: "member", viaMachineCredential: false };

const sorts: unknown[] = [];
const limits: unknown[] = [];
const populates: unknown[][] = [];

function mockRuns(list: unknown[]) {
  runFind.mockReturnValue({
    sort: (spec: unknown) => {
      sorts.push(spec);
      return {
        limit: (n: unknown) => {
          limits.push(n);
          const chain = {
            populate: (...args: unknown[]) => {
              populates.push(args);
              return chain;
            },
            lean: () => Promise.resolve(list),
          };
          return chain;
        },
      };
    },
  });
}

function runDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "69a52e3b399b27d3cbb2c5a5",
    taskKey: "BP-158",
    agentName: "Default",
    outcome: "failed",
    refusedBy: "",
    detail: "the build failed: 2 tests red",
    minutes: 4,
    startedAt: new Date("2026-08-25T10:00:00.000Z"),
    finishedAt: new Date("2026-08-25T10:04:00.000Z"),
    costUsd: 0.42,
    project: { _id: "p1", key: "BP", name: "Board Planner" },
    worker: { _id: "w1", name: "owner-mac" },
    ...overrides,
  };
}

function request(query = "") {
  return new Request(`http://localhost/api/admin/runs${query}`);
}

const call = (query = "") => GET(request(query), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  sorts.length = 0;
  limits.length = 0;
  populates.length = 0;
  check.mockResolvedValue(false);
  getAuthUser.mockResolvedValue(ADMIN);
  mockRuns([]);
});

describe("GET /api/admin/runs", () => {
  it("refuses a member", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    check.mockResolvedValue(true);

    const response = await call();

    expect(response.status).toBe(403);
    expect(runFind).not.toHaveBeenCalled();
  });

  // An unscoped admin API token keeps role "admin", and one on a worker's disk is readable by the
  // agent running there — which would hand it every project's run detail
  it("refuses an admin credential presented by a machine", async () => {
    getAuthUser.mockResolvedValue({ ...ADMIN, viaMachineCredential: true });

    const response = await call();

    expect(response.status).toBe(403);
    expect(runFind).not.toHaveBeenCalled();
  });

  it("hands back what a finished run said, with the project and machine that ran it", async () => {
    mockRuns([runDoc()]);

    const [run] = await (await call()).json();

    expect(run.detail).toBe("the build failed: 2 tests red");
    expect(run.taskKey).toBe("BP-158");
    expect(run.projectKey).toBe("BP");
    expect(run.projectName).toBe("Board Planner");
    expect(run.workerName).toBe("owner-mac");
    expect(run.minutes).toBe(4);
  });

  // An unpopulated ref serialises as a bare id, and rendering one would put "6a70…" in the column
  // that exists to name a machine
  it("reports no machine rather than an id when the ref was not populated", async () => {
    mockRuns([runDoc({ worker: null, project: null })]);

    const [run] = await (await call()).json();

    expect(run.workerName).toBe("");
    expect(run.projectKey).toBe("");
  });

  it("reads the newest first", async () => {
    await call();

    expect(sorts[0]).toEqual({ finishedAt: -1 });
  });

  it("asks for the names the console renders", async () => {
    await call();

    expect(populates).toEqual([
      ["project", "key name"],
      ["worker", "name"],
    ]);
  });

  // Number("") is 0 and Mongoose reads .limit(0) as no limit at all, which on a fleet-wide read is
  // every run this instance has ever recorded
  it("keeps a default limit when the parameter is blank or nonsense", async () => {
    await call("?limit=");
    await call("?limit=abc");
    await call("?limit=-5");

    expect(limits).toEqual([50, 50, 50]);
  });

  it("caps how much can be asked for", async () => {
    await call("?limit=5000");

    expect(limits[0]).toBe(200);
  });

  it("honours a limit within the cap", async () => {
    await call("?limit=10");

    expect(limits[0]).toBe(10);
  });
});
