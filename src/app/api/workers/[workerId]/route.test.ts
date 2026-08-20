import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const verifyWorkerCredential = vi.fn();
const workerFindById = vi.fn();
const projectFind = vi.fn();
const countDocuments = vi.fn();
const accessibleProjectIds = vi.fn();
const userFindById = vi.fn();
const workerFindOthers = vi.fn();
const workerFindByIdAndUpdate = vi.fn();
const logInstanceAudit = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("@/models/task", () => ({ Task: {} }));
vi.mock("@/models/project", () => ({
  Project: { find: () => ({ select: () => ({ lean: projectFind }) }), countDocuments },
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
const OWNER_ID = "6a732075133f935b19154cd2";

const INSTANCE_ADMIN = { _id: "admin-1", role: "admin" };
const PLAIN_MEMBER = { _id: "member-1", role: "member" };
// A project owner used to reach the policy fields here. Those describe the work and moved to the
// project, so this route is instance-admin only now. Ownership is a grant, so the test that uses
// this one has check() answer true for it.
const PROJECT_OWNER = { _id: "powner-1", role: "member" };
// An API token with no project scope never passes through applyTokenScope, so tokenScoped stays
// false and it stayed an instance admin — the credential the worker itself used to hold.
const UNSCOPED_ADMIN_TOKEN = {
  _id: "admin-1",
  role: "admin",
  viaMachineCredential: true,
};

const WORKER = {
  _id: WORKER_ID,
  name: "rig-laptop",
  host: "mac.home",
  lastSeenAt: new Date(),
  policy: { pollIntervalMs: 30_000 },
  policyOverrides: [],
  repos: [{ remote: "git@github.com:owner/repo.git", path: "/repo" }],
  // BP-305/BP-358: assignments are what the owner can reach, narrowed by the reported repos
  owner: OWNER_ID,
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
const patchPopulates: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue(false);
  workerFindById.mockResolvedValue(WORKER);
  patchPopulates.length = 0;
  workerFindByIdAndUpdate.mockReturnValue({
    populate: (...args: unknown[]) => {
      patchPopulates.push(args);
      return Promise.resolve({ ...WORKER, name: "renamed" });
    },
  });
  verifyWorkerCredential.mockResolvedValue(WORKER);
  workerFindOthers.mockResolvedValue([]);
  userFindById.mockResolvedValue({ _id: OWNER_ID, role: "member" });
  accessibleProjectIds.mockResolvedValue(["p1"]);
  projectFind.mockResolvedValue([
    {
      _id: "p1",
      githubRepo: "owner/repo",
      worker: { enabled: true, policy: { model: "sonnet" }, policyOverrides: ["model"] },
    },
  ]);
});

// BP-358 removed the stored approved set: what a machine may serve is what its owner may serve,
// resolved live. A stale writer would have quietly reintroduced the per-worker grant it replaced.
describe("PATCH no longer writes a per-worker project list", () => {
  const PROJECT = "69a52e3b399b27d3cbb2c5c9";

  beforeEach(() => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
  });

  it("treats approvedProjects as nothing to update rather than storing it", async () => {
    countDocuments.mockResolvedValue(1);

    const res = await PATCH(patchRequest({ approvedProjects: [PROJECT] }), ctx());

    expect(res.status).toBe(400);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  // Sent alongside a field this route does accept: the request goes through, and the list is
  // dropped rather than riding along into the update
  it("drops it from an otherwise valid update", async () => {
    const res = await PATCH(patchRequest({ enabled: false, approvedProjects: [PROJECT] }), ctx());

    expect(res.status).toBe(200);
    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set).toEqual({ enabled: false });
  });
});

// BP-358: registration refuses to re-register a machine that belongs to somebody else, so a machine
// whose owner has left needs a way to be let go — or it can never be enrolled again under the same
// name and host.
describe("PATCH releases a machine from its owner", () => {
  beforeEach(() => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
  });

  // Without it toApiWorker answers `owner: null` for a machine that has one, the console merges
  // that into the row it just changed, and the Owner column flashes its red "claims nothing" flag
  // until the next poll — a false alarm on the indicator this branch added, raised by the page's
  // most-used control.
  it("answers with the owner's name, not a bare reference", async () => {
    await PATCH(patchRequest({ enabled: false }), ctx());

    expect(patchPopulates).toEqual([["owner", "username fullName"]]);
  });

  it("clears the owner", async () => {
    const res = await PATCH(patchRequest({ owner: null }), ctx());

    expect(res.status).toBe(200);
    expect(workerFindByIdAndUpdate.mock.calls[0][1].$set).toEqual({ owner: null });
  });

  // Clearing is the recovery; assigning from here would hand the decision to somebody who is not at
  // the machine, which is the step BP-358 removed
  it("refuses to assign one instead", async () => {
    const res = await PATCH(patchRequest({ owner: "6a732075133f935b19154cd3" }), ctx());

    expect(res.status).toBe(400);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("records the release, naming what it means", async () => {
    await PATCH(patchRequest({ owner: null }), ctx());

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "worker_released", target: "rig-laptop" })
    );
  });

  it("records nothing when the machine had no owner to release", async () => {
    workerFindById.mockResolvedValue({ ...WORKER, owner: null });

    await PATCH(patchRequest({ owner: null }), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("is refused to anyone but an instance admin", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);

    expect((await PATCH(patchRequest({ owner: null }), ctx())).status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });
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

  // Owning a project no longer buys anything here: what the work looks like is set on the
  // project, and what the machine does is the instance's business.
  it("refuses a project owner", async () => {
    getAuthUser.mockResolvedValue(PROJECT_OWNER);
    check.mockResolvedValue(true);

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
      const response = await PATCH(patchRequest({ baseBranch: "develop" }), ctx());

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
// BP-305: the one withWorker route that answered a killed worker, handing it its policy, its
// assignments and the whole fleet inventory
describe("the kill switch covers this route too", () => {
  function killSwitchRequest() {
    return new Request(`http://localhost/api/workers/${WORKER_ID}`, {
      headers: {
        authorization: "Bearer cpw_secret",
        "x-worker-id": WORKER_ID,
        "x-cp-protocol": "1",
      },
    });
  }

  it.each([{ enabled: false }, { lockedByInstance: true }])(
    "refuses a worker that may not run (%o)",
    async (state) => {
      verifyWorkerCredential.mockResolvedValue({ ...WORKER, ...state });

      const res = await GET(killSwitchRequest(), ctx());

      expect(res.status).toBe(403);
    }
  );
});

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
      { project: "p1", remote: "git@github.com:owner/repo.git", policy: { model: "sonnet" } },
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

  // BP-358: this is the field the worker's own loop reads and iterates to attempt a claim, so an
  // ownerless machine offered one here would poll straight into a claim it cannot win.
  it("offers nothing to a machine with no owner, even when it matches an enabled project", async () => {
    verifyWorkerCredential.mockResolvedValue({ ...WORKER, owner: null });

    expect((await (await GET(getRequest(), ctx())).json()).assignments).toEqual([]);
  });

  it("offers nothing for a project its owner cannot reach", async () => {
    accessibleProjectIds.mockResolvedValue(["some-other-project"]);

    expect((await (await GET(getRequest(), ctx())).json()).assignments).toEqual([]);
  });

  // BP-375. The app can only offer to set up a project it has been told about, and assignments name
  // only the ones already working — which is why adding the second project was a git clone in a
  // terminal that nothing on screen mentions.
  describe("the projects this machine could set up", () => {
    beforeEach(() => {
      accessibleProjectIds.mockResolvedValue(["p1", "p2"]);
      projectFind.mockResolvedValue([
        {
          _id: "p1",
          githubRepo: "owner/repo",
          key: "BP",
          name: "Board Planner",
          worker: { enabled: true, policy: {}, policyOverrides: [] },
        },
        {
          _id: "p2",
          githubRepo: "owner/sandbox",
          key: "SB",
          name: "Sandbox",
          worker: { enabled: true, policy: {}, policyOverrides: [] },
        },
      ]);
    });

    it("names the one with no checkout here, with the address to clone", async () => {
      const json = await (await GET(getRequest(), ctx())).json();

      expect(json.offers).toEqual([
        {
          project: "p2",
          key: "SB",
          name: "Sandbox",
          repositoryUrl: "https://github.com/owner/sandbox",
        },
      ]);
    });

    // The one being served is not something to add, and offering it invites a second clone of a
    // repository this machine already has.
    it("says nothing about the project it is already working on", async () => {
      const json = await (await GET(getRequest(), ctx())).json();

      expect(json.offers.map((o: { project: string }) => o.project)).not.toContain("p1");
      expect(json.assignments.map((a: { project: string }) => a.project)).toEqual(["p1"]);
    });

    it("offers nothing outside its owner's reach, the same as an assignment", async () => {
      accessibleProjectIds.mockResolvedValue(["p1"]);

      expect((await (await GET(getRequest(), ctx())).json()).offers).toEqual([]);
    });
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

// BP-233. BP-232 removed stored worker assignments and the audit call that hung off them went with
// it, so stopping a machine became a thing nobody could prove had happened.
describe("what the fleet audit log records", () => {
  const entries = () => logInstanceAudit.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    getAuthUser.mockResolvedValue(INSTANCE_ADMIN);
    workerFindById.mockResolvedValue({ ...WORKER });
    workerFindByIdAndUpdate.mockReturnValue({ populate: () => Promise.resolve({ ...WORKER }) });
  });

  it("records the kill switch as its own action, not as an update", async () => {
    await PATCH(patchRequest({ lockedByInstance: true }), ctx());

    expect(entries()).toEqual([
      expect.objectContaining({
        action: "worker_locked",
        target: "rig-laptop",
        user: "admin-1",
      }),
    ]);
  });

  it("distinguishes clearing the kill switch from setting it", async () => {
    workerFindById.mockResolvedValue({ ...WORKER, lockedByInstance: true });

    await PATCH(patchRequest({ lockedByInstance: false }), ctx());

    expect(entries()[0].action).toBe("worker_unlocked");
  });

  it("separates disabling a worker from stopping it", async () => {
    await PATCH(patchRequest({ enabled: false }), ctx());

    expect(entries()[0].action).toBe("worker_disabled");
  });

  // The old name, because that is what earlier rows call this machine and a reader following its
  // history backwards has nothing else to match on
  it("names a rename by where it came from as well as where it went", async () => {
    await PATCH(patchRequest({ name: "studio-mini" }), ctx());

    expect(entries()[0]).toMatchObject({
      action: "worker_renamed",
      target: "rig-laptop",
      detail: expect.stringContaining("studio-mini"),
    });
  });

  it("records the poll interval it moved from", async () => {
    // Pinned in the fixture: the stored 30000 on an unpinned worker is inert, so the interval it
    // moved from is the default, not that number
    workerFindById.mockResolvedValue({ ...WORKER, policyOverrides: ["pollIntervalMs"] });

    await PATCH(patchRequest({ pollIntervalMs: 60_000 }), ctx());

    expect(entries()[0]).toMatchObject({
      action: "worker_poll_interval_changed",
      detail: expect.stringContaining("30000"),
    });
  });

  // One request, two changes, two rows — a reader scanning actions should not have to unpack a
  // detail column to find the one that stopped the machine
  it("writes one entry per field that actually changed", async () => {
    await PATCH(patchRequest({ lockedByInstance: true, enabled: false }), ctx());

    expect(entries().map((e) => e.action)).toEqual(["worker_locked", "worker_disabled"]);
  });

  it("records nothing for a field resent with the value it already had", async () => {
    await PATCH(patchRequest({ enabled: true, name: "rig-laptop" }), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // The stored copy is inert until somebody pins it: the schema materialises pollIntervalMs into
  // every worker, but the machine resolves against its own default unless the field is in
  // policyOverrides. So resending the default is a real change — it pins it — and comparing
  // against the stored value read that as no change at all.
  it("records pinning the default, which is a change the stored value cannot show", async () => {
    workerFindById.mockResolvedValue({ ...WORKER, policyOverrides: [] });

    await PATCH(patchRequest({ pollIntervalMs: 30_000 }), ctx());

    expect(entries()[0]).toMatchObject({
      action: "worker_poll_interval_changed",
      detail: expect.stringContaining("default"),
    });
  });

  it("records nothing when a pinned interval is resent unchanged", async () => {
    workerFindById.mockResolvedValue({ ...WORKER, policyOverrides: ["pollIntervalMs"] });

    await PATCH(patchRequest({ pollIntervalMs: 30_000 }), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  // Otherwise the log asserts a kill switch that never landed, right before the handler throws
  it("records nothing when the document is gone by the time it is written", async () => {
    workerFindByIdAndUpdate.mockReturnValue({ populate: () => Promise.resolve(null) });

    const response = await PATCH(patchRequest({ lockedByInstance: true }), ctx());

    expect(response.status).toBe(404);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("records nothing when the request is refused", async () => {
    getAuthUser.mockResolvedValue(PLAIN_MEMBER);

    await PATCH(patchRequest({ lockedByInstance: true }), ctx());

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });
});
