import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const accessibleProjectIds = vi.fn();
const ownerReachableProjectIds = vi.fn();
const workerFindById = vi.fn();
const workerFindOthers = vi.fn();
const workerUpdateOne = vi.fn();
const projectFind = vi.fn();
const projectUpdateOne = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ accessibleProjectIds, check: vi.fn() }));
vi.mock("@/models/user", () => ({ User: {} }));
vi.mock("@/models/task", () => ({ Task: {} }));
// The filter is honoured rather than discarded. A stub that answers every query with the same rows
// makes `find({_id: {$in: wanted}})` look like it returned projects the route had already refused —
// which is a failing assertion about the stub, not about the code.
vi.mock("@/models/project", () => ({
  Project: {
    find: (query?: { _id?: { $in?: string[] } }) => ({
      select: () => ({
        lean: async () => {
          const all = await projectFind();
          const wanted = query?._id?.$in;
          return wanted ? all.filter((p: { _id: string }) => wanted.includes(String(p._id))) : all;
        },
      }),
    }),
    updateOne: projectUpdateOne,
  },
}));
vi.mock("@/models/worker", () => ({
  Worker: {
    findById: () => ({ select: workerFindById }),
    find: () => ({ select: workerFindOthers }),
    updateOne: workerUpdateOne,
  },
}));
vi.mock("@/lib/worker-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-service")>();
  return { ...actual, ownerReachableProjectIds };
});

const { GET, PUT } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const OWNER_ID = "6a732075133f935b19154cd2";
const SERVED = "69a52e3b399b27d3cbb2c5b1";
const OFF = "69a52e3b399b27d3cbb2c5b2";
const REMOTE = "git@github.com:owner/repo.git";

const OWNER = { _id: OWNER_ID, role: "member" };
const ADMIN = { _id: "admin-1", role: "admin" };

function ctx() {
  return { params: Promise.resolve({ workerId: WORKER_ID }) } as never;
}

function putRequest(body: unknown) {
  return new Request(`http://localhost/api/workers/${WORKER_ID}/projects`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const getRequest = () => new Request(`http://localhost/api/workers/${WORKER_ID}/projects`);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(OWNER);
  accessibleProjectIds.mockResolvedValue(null);
  ownerReachableProjectIds.mockResolvedValue(null);
  workerFindById.mockResolvedValue({
    _id: WORKER_ID,
    name: "rig-mac",
    host: "mac.home",
    owner: OWNER_ID,
    repos: [{ remote: REMOTE, path: "/checkouts/BP" }],
    desiredProjects: undefined,
  });
  workerFindOthers.mockResolvedValue([]);
  projectFind.mockResolvedValue([
    { _id: SERVED, key: "BP", name: "Board Planner", githubRepo: "owner/repo", worker: { enabled: true } },
    { _id: OFF, key: "SB", name: "Sandbox", githubRepo: "owner/sandbox", worker: { enabled: false } },
  ]);
});

describe("GET the picker's own view", () => {
  it("carries every reachable project, with the served one already ticked", async () => {
    const json = await (await GET(getRequest(), ctx())).json();

    expect(json.catalogue).toEqual([
      expect.objectContaining({ key: "BP", servedHere: true, wanted: true }),
      expect.objectContaining({ key: "SB", servedHere: false, workersEnabled: false }),
    ]);
  });

  // The screen has to know before it renders whether a switched-off project is tickable here or
  // only somewhere else, or it promises something the PUT will not do.
  it("says whether this person can switch workers on while they are here", async () => {
    expect((await (await GET(getRequest(), ctx())).json()).canEnableWorkers).toBe(false);

    getAuthUser.mockResolvedValue(ADMIN);
    expect((await (await GET(getRequest(), ctx())).json()).canEnableWorkers).toBe(true);
  });

  it("answers 404 for somebody else's machine, the same as for one that does not exist", async () => {
    getAuthUser.mockResolvedValue({ _id: "stranger", role: "member" });

    expect((await GET(getRequest(), ctx())).status).toBe(404);
  });
});

describe("PUT the selection", () => {
  it("stores what was picked", async () => {
    const response = await PUT(putRequest({ projects: [SERVED] }), ctx());

    expect(response.status).toBe(200);
    expect(workerUpdateOne).toHaveBeenCalledWith(
      { _id: WORKER_ID },
      { $set: { desiredProjects: [SERVED] } }
    );
  });

  // This is the whole reason the screen lives in a browser rather than in the app
  it("switches workers on for a picked project when an instance admin is confirming", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const json = await (await PUT(putRequest({ projects: [SERVED, OFF] }), ctx())).json();

    expect(projectUpdateOne).toHaveBeenCalledWith(
      { _id: OFF },
      { $set: { "worker.enabled": true } }
    );
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project_workers_enabled", target: "SB" })
    );
    expect(json.leftDisabled).toEqual([]);
  });

  // A machine picked for a project nobody committed to machines would sit idle with nothing on it
  // to say why. Naming them is what lets the screen say it instead.
  it("names the projects it left switched off when the person cannot switch them", async () => {
    const json = await (await PUT(putRequest({ projects: [SERVED, OFF] }), ctx())).json();

    expect(projectUpdateOne).not.toHaveBeenCalled();
    expect(json.leftDisabled).toEqual(["SB"]);
  });

  it("refuses a project the caller cannot reach", async () => {
    accessibleProjectIds.mockResolvedValue([SERVED]);

    const json = await (await PUT(putRequest({ projects: [SERVED, OFF] }), ctx())).json();

    expect(json.projects).toEqual([SERVED]);
    expect(json.refused).toEqual([OFF]);
  });

  // Recording a project the machine's owner cannot reach would be recorded as wanted and refused
  // on every claim — a machine that looks configured and does nothing.
  it("refuses a project the machine's owner cannot reach, even for an admin who can", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    ownerReachableProjectIds.mockResolvedValue([SERVED]);

    const json = await (await PUT(putRequest({ projects: [SERVED, OFF] }), ctx())).json();

    expect(json.projects).toEqual([SERVED]);
    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  it("takes an empty selection as a selection, since that is how the last checkout is removed", async () => {
    await PUT(putRequest({ projects: [] }), ctx());

    expect(workerUpdateOne).toHaveBeenCalledWith(
      { _id: WORKER_ID },
      { $set: { desiredProjects: [] } }
    );
  });

  it("refuses a body that carries no list at all, rather than reading it as an empty one", async () => {
    expect((await PUT(putRequest({}), ctx())).status).toBe(400);
    expect(workerUpdateOne).not.toHaveBeenCalled();
  });

  // The choice is a person's, and a machine credential is exactly what this route must not accept:
  // the app holds one, and the app is the thing that would otherwise be able to widen its own reach.
  it("refuses a machine credential", async () => {
    getAuthUser.mockResolvedValue({ ...OWNER, viaMachineCredential: true });

    expect((await PUT(putRequest({ projects: [SERVED] }), ctx())).status).toBe(403);
    expect(workerUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses somebody else's machine", async () => {
    getAuthUser.mockResolvedValue({ _id: "stranger", role: "member" });

    expect((await PUT(putRequest({ projects: [SERVED] }), ctx())).status).toBe(404);
    expect(workerUpdateOne).not.toHaveBeenCalled();
  });

  it("drops a duplicate and a malformed id rather than storing them", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const json = await (await PUT(putRequest({ projects: [SERVED, SERVED, "not-an-id"] }), ctx())).json();

    expect(json.projects).toEqual([SERVED]);
  });
});
