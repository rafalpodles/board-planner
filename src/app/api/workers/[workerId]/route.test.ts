import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const verifyWorkerCredential = vi.fn();
const workerFindById = vi.fn();
const projectFind = vi.fn();
const workerFindOthers = vi.fn();
const workerFindByIdAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/task", () => ({ Task: {} }));
vi.mock("@/models/project", () => ({
  Project: { find: () => ({ select: () => ({ lean: projectFind }) }) },
}));
vi.mock("@/models/worker", () => ({
  Worker: {
    findById: workerFindById,
    findByIdAndUpdate: workerFindByIdAndUpdate,
    find: () => ({ select: workerFindOthers }),
  },
}));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, verifyWorkerCredential };
});

const { GET, PATCH } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";

const INSTANCE_ADMIN = { _id: "admin-1", role: "admin", allowedProjects: [] };
const PLAIN_MEMBER = { _id: "member-1", role: "member", allowedProjects: [] };
// A project admin used to reach the policy fields here. Those describe the work and moved to the
// project, so this route is instance-admin only now.
const PROJECT_ADMIN = { _id: "padmin-1", role: "member", allowedProjects: ["p1"] };
// An API token with no project scope never passes through applyTokenScope, so tokenScoped stays
// false and it stayed an instance admin — the credential the worker itself used to hold.
const UNSCOPED_ADMIN_TOKEN = {
  _id: "admin-1",
  role: "admin",
  viaMachineCredential: true,
  allowedProjects: [],
};

const WORKER = {
  _id: WORKER_ID,
  name: "rig-laptop",
  host: "mac.home",
  lastSeenAt: new Date(),
  policy: { pollIntervalMs: 30_000 },
  policyOverrides: [],
  repos: [{ remote: "git@github.com:owner/repo.git", path: "/repo" }],
  enabled: true,
  lockedByInstance: false,
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date(),
};

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/workers/${WORKER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({ workerId: WORKER_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  workerFindById.mockResolvedValue(WORKER);
  workerFindByIdAndUpdate.mockResolvedValue({ ...WORKER, name: "renamed" });
  verifyWorkerCredential.mockResolvedValue(WORKER);
  workerFindOthers.mockResolvedValue([]);
  projectFind.mockResolvedValue([
    {
      _id: "p1",
      githubRepo: "owner/repo",
      worker: { enabled: true, policy: { autoMerge: true }, policyOverrides: ["autoMerge"] },
    },
  ]);
});

describe("PATCH /api/workers/:workerId", () => {
  it("lets an instance admin rename, enable and lock a machine", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);

    const response = await PATCH(patchRequest({ name: "rig", lockedByInstance: true }), ctx());

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      { $set: { name: "rig", lockedByInstance: true } },
      { new: true }
    );
  });

  it("sets the machine's poll interval and records it as chosen", async () => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);

    await PATCH(patchRequest({ pollIntervalMs: 5000 }), ctx());

    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set).toEqual({
      "policy.pollIntervalMs": 5000,
      policyOverrides: ["pollIntervalMs"],
    });
  });

  // Found by driving a real server: an unscoped admin API token passed the old tokenScoped guard
  // and cleared lockedByInstance — the kill switch, lifted by the credential the worker held.
  it("refuses an unscoped admin API token, which is still a machine credential", async () => {
    getAuthUser.mockResolvedValue(UNSCOPED_ADMIN_TOKEN);

    const response = await PATCH(patchRequest({ lockedByInstance: false }), ctx());

    expect(response.status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a plain member", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);

    expect((await PATCH(patchRequest({ name: "x" }), ctx())).status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Being admin of a project no longer buys anything here: what the work looks like is set on the
  // project, and what the machine does is the instance's business.
  it("refuses a project admin", async () => {
    getAuthUser.mockResolvedValue(PROJECT_ADMIN);

    expect((await PATCH(patchRequest({ pollIntervalMs: 5000 }), ctx())).status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  describe("validation", () => {
    beforeEach(() => getAuthUser.mockResolvedValue(INSTANCE_ADMIN));

    it("refuses a non-boolean enabled", async () => {
      expect((await PATCH(patchRequest({ enabled: "yes" }), ctx())).status).toBe(400);
    });

    it("refuses a blank name rather than storing it", async () => {
      expect((await PATCH(patchRequest({ name: "   " }), ctx())).status).toBe(400);
    });

    it("refuses a poll interval that is not a positive integer", async () => {
      for (const bad of [0, -1, 1.5, "5000"]) {
        expect((await PATCH(patchRequest({ pollIntervalMs: bad }), ctx())).status).toBe(400);
      }
      expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    // Work policy belongs to the project; accepting it here would leave two places to set it
    it("ignores a field that moved to the project", async () => {
      const response = await PATCH(patchRequest({ autoMerge: true, baseBranch: "develop" }), ctx());

      expect(response.status).toBe(400);
      expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("404s on an unknown worker", async () => {
      workerFindById.mockResolvedValue(null);

      expect((await PATCH(patchRequest({ name: "x" }), ctx())).status).toBe(404);
    });
  });
});

// The worker polls this between heartbeats for its current policy and assignments. It returned
// neither once assignments stopped being stored, so a worker that had reported its checkouts never
// learned which projects they matched — caught by running it, not by a test.
describe("GET /api/workers/:workerId", () => {
  function getRequest() {
    return new Request(`http://localhost/api/workers/${WORKER_ID}`, {
      headers: {
        authorization: "Bearer cpw_secret",
        "x-worker-id": WORKER_ID,
        "x-cp-protocol": "1",
      },
    });
  }

  it("answers with the assignments its reported checkouts match", async () => {
    const json = await (await GET(getRequest(), ctx())).json();

    expect(json.assignments).toEqual([
      { project: "p1", remote: "git@github.com:owner/repo.git", policy: { autoMerge: true } },
    ]);
  });

  it("answers with the machine's own policy, not the project's", async () => {
    const json = await (await GET(getRequest(), ctx())).json();

    expect(json.policy).toEqual({});
  });

  it("offers nothing when no project is enabled for workers", async () => {
    projectFind.mockResolvedValue([]);

    expect((await (await GET(getRequest(), ctx())).json()).assignments).toEqual([]);
  });
});

// The heartbeat also computes assignments, but nothing reads that field — the worker only ever uses
// this route. So the contested-checkout decision has to be applied here or it is not applied at all.
describe("GET and a contested checkout", () => {
  function getRequest() {
    return new Request(`http://localhost/api/workers/${WORKER_ID}`, {
      headers: {
        authorization: "Bearer cpw_secret",
        "x-worker-id": WORKER_ID,
        "x-cp-protocol": "1",
      },
    });
  }

  it("withholds a project whose checkout an earlier live process on this host holds", async () => {
    workerFindOthers.mockResolvedValue([
      {
        _id: "w0",
        name: "older",
        host: "mac.home",
        enabled: true,
        lockedByInstance: false,
        lastSeenAt: new Date(),
        createdAt: new Date("2020-01-01"),
        repos: [{ remote: "git@github.com:owner/repo.git", path: "/repo" }],
      },
    ]);

    expect((await (await GET(getRequest(), ctx())).json()).assignments).toEqual([]);
  });

  it("consults the other workers at all", async () => {
    await GET(getRequest(), ctx());

    expect(workerFindOthers).toHaveBeenCalled();
  });
});
