import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import sift from "sift";
import { Types } from "mongoose";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const ensureWorkerUser = vi.fn();
const userFindById = vi.fn();
const grantFind = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
const workerFindOne = vi.fn();
vi.mock("@/models/worker", () => ({
  Worker: { findById, findOne: workerFindOne, findOneAndUpdate, updateOne },
}));
vi.mock("@/lib/worker-user", () => ({ ensureWorkerUser }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));
vi.mock("@/models/grant", () => ({ Grant: { find: grantFind } }));

const {
  assignmentsFor,
  catalogueFor,
  offersFor,
  lostCheckouts,
  usableRepos,
  overriddenWorkerPolicy,
  ownerReachableProjectIds,
  registerWorker,
  WorkerAlreadyOwned,
  verdictFor: rawVerdictFor,
  verifyWorkerCredential,
  PROTOCOL_VERSION,
  WORKER_STALE_MS,
  WORKER_HEARTBEAT_MS,
} = await import("./worker-service");

const verdictFor = (...args: Parameters<typeof rawVerdictFor>) =>
  rawVerdictFor(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args.length > 5 ? args[5] : [PROJECT_ID]
  );

const now = new Date("2026-08-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 1000);
const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const REMOTE = "git@github.com:owner/repo.git";

function project(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROJECT_ID,
    githubRepo: "owner/repo",
    worker: { enabled: true, policy: {}, policyOverrides: [] },
    ...overrides,
  } as never;
}

function worker(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    protocolVersion: PROTOCOL_VERSION,
    lastSeenAt: fresh,
    host: "mac.home",
    repos: [{ remote: REMOTE, path: "/repo" }],
    owner: "6a732075133f935b19154cd2",
    ...overrides,
  } as never;
}

describe("verdictFor", () => {
  it("admits a healthy worker assigned to the project", () => {
    expect(verdictFor(worker(), project(), PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  it.each([
    ["disabled", { enabled: false }, /disabled/i],
    ["locked by the instance", { lockedByInstance: true }, /locked/i],
    ["reporting no checkout of this project", { repos: [] }, /no checkout/i],
  ])("refuses a worker %s", (_label, overrides, pattern) => {
    const verdict = verdictFor(worker(overrides), project(), PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(pattern);
  });

  it("refuses a request speaking an older protocol", () => {
    expect(verdictFor(worker(), project(), PROTOCOL_VERSION - 1, now).ok).toBe(false);
  });

  it("refuses a request with no protocol at all", () => {
    const verdict = verdictFor(worker(), project(), NaN, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/protocol/i);
  });

  it("refuses a worker that has stopped heartbeating", () => {
    const stale = new Date(now.getTime() - WORKER_STALE_MS - 1);

    expect(verdictFor(worker({ lastSeenAt: stale }), project(), PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("refuses a worker that has never heartbeaten", () => {
    expect(verdictFor(worker({ lastSeenAt: null }), project(), PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("refuses a worker whose lastSeenAt does not parse as a date", () => {
    const verdict = verdictFor(worker({ lastSeenAt: "not-a-date" }), project(), PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/reported/i);
  });

  it("refuses when the project could not be resolved at all", () => {
    const verdict = verdictFor(worker(), null, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/not enabled/i);
  });

  it("refuses an enabled project whose repository this machine lacks", () => {
    const verdict = verdictFor(worker(), project({ githubRepo: "someone/else" }), PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/no checkout/i);
  });

  it("refuses a project that names no repository at all", () => {
    const nameless = project({ githubRepo: "", gitlabRepo: "" });

    expect(verdictFor(worker(), nameless, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("heartbeats comfortably inside the staleness window", () => {
    expect(WORKER_HEARTBEAT_MS * 2).toBeLessThan(WORKER_STALE_MS);
  });

  it("refuses a machine with no owner", () => {
    const verdict = verdictFor(
      worker({ owner: null }),
      project(),
      PROTOCOL_VERSION,
      now,
      []
    );

    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { reason: string }).reason).toMatch(/owner/i);
  });

  it("lets a machine with an owner through", () => {
    expect(verdictFor(worker(), project(), PROTOCOL_VERSION, now, []).ok).toBe(true);
  });
});

describe("verifyWorkerCredential", () => {
  const workerId = "69a52e3b399b27d3cbb2c5a5";

  beforeEach(() => findById.mockReset());

  it("rejects a malformed worker id without touching the database", async () => {
    expect(await verifyWorkerCredential("not-an-object-id", "cpw_x")).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects a non-string credential without touching the database", async () => {
    expect(await verifyWorkerCredential(workerId, undefined as unknown as string)).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker", async () => {
    findById.mockReturnValue({ select: () => Promise.resolve(null) });

    expect(await verifyWorkerCredential(workerId, "cpw_x")).toBeNull();
  });

  it("asks for credentialHash explicitly, since the schema hides it by default", async () => {
    const select = vi.fn().mockResolvedValue(null);
    findById.mockReturnValue({ select });

    await verifyWorkerCredential(workerId, "cpw_x");

    expect(select).toHaveBeenCalledWith("+credentialHash");
  });

  it("accepts a correct credential", async () => {
    const credentialHash = bcrypt.hashSync("cpw_secret", 10);
    const stored = { _id: workerId, credentialHash };
    findById.mockReturnValue({ select: () => Promise.resolve(stored) });

    expect(await verifyWorkerCredential(workerId, "cpw_secret")).toBe(stored);
  });

  it("rejects an incorrect credential", async () => {
    const credentialHash = bcrypt.hashSync("cpw_secret", 10);
    findById.mockReturnValue({ select: () => Promise.resolve({ _id: workerId, credentialHash }) });

    expect(await verifyWorkerCredential(workerId, "cpw_wrong")).toBeNull();
  });
});

describe("registerWorker", () => {
  const REGISTERED = { _id: "w1" };
  const OWNER_ID = "6a732075133f935b19154cd2";
  const SOMEBODY_ELSE = "6a732075133f935b19154cd3";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function byValue(value: any): any {
    if (value instanceof Types.ObjectId) return String(value);
    if (Array.isArray(value)) return value.map(byValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, byValue(v)]));
    }
    return value;
  }

  function storedMachine(doc: Record<string, unknown> | null) {
    workerFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(doc ? { owner: doc.owner ?? null } : null) }),
    });
    findOneAndUpdate.mockImplementation((filter: Record<string, unknown>) => {
      if (!doc) return Promise.resolve({ ...REGISTERED });
      if (sift(byValue(filter))(byValue(doc))) return Promise.resolve({ ...REGISTERED });
      return Promise.reject(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
    });
  }

  const alreadyThere = (owner: unknown) =>
    storedMachine({ name: "rig", host: "mac.home", owner });

  beforeEach(() => {
    vi.clearAllMocks();
    storedMachine(null);
    updateOne.mockResolvedValue({});
    ensureWorkerUser.mockResolvedValue({ _id: "identity-1" });
  });

  it("writes owner as a real ObjectId when ownerId is given", async () => {
    const ownerId = "6a732075133f935b19154cd2";

    await registerWorker({ name: "rig", host: "mac.home", platform: "darwin", version: "1.0.0", ownerId });

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.owner).toBeInstanceOf(Types.ObjectId);
    expect(update.$set.owner.equals(ownerId)).toBe(true);
  });

  it("never clears an existing owner when ownerId is omitted", async () => {
    await registerWorker({ name: "rig", host: "mac.home", platform: "darwin", version: "1.0.0" });

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).not.toHaveProperty("owner");
  });

  describe("a machine that already belongs to somebody", () => {
    it("refuses to re-register it for a different person", async () => {
      alreadyThere(SOMEBODY_ELSE);

      await expect(
        registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID })
      ).rejects.toBeInstanceOf(WorkerAlreadyOwned);
      expect(ensureWorkerUser).not.toHaveBeenCalled();
    });

    it("refuses through the update filter rather than a prior read", async () => {
      alreadyThere(SOMEBODY_ELSE);

      await expect(
        registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID })
      ).rejects.toBeInstanceOf(WorkerAlreadyOwned);
      expect(findOneAndUpdate).toHaveBeenCalled();
    });

    it("lets its own owner register it again", async () => {
      alreadyThere(OWNER_ID);

      await registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID });

      expect(findOneAndUpdate).toHaveBeenCalled();
    });

    it("recognises its owner through an ObjectId", async () => {
      alreadyThere(new Types.ObjectId(OWNER_ID));

      await registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID });

      expect(findOneAndUpdate).toHaveBeenCalled();
    });

    it("refuses even when the caller names no owner at all", async () => {
      alreadyThere(SOMEBODY_ELSE);

      await expect(
        registerWorker({ name: "rig", host: "mac.home", platform: "", version: "" })
      ).rejects.toBeInstanceOf(WorkerAlreadyOwned);
    });
  });

  describe("adopting a machine nobody owns", () => {
    it("is allowed", async () => {
      alreadyThere(null);

      await registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID });

      expect(findOneAndUpdate.mock.calls[0][1].$set.owner).toBeInstanceOf(Types.ObjectId);
    });

    it("does not inherit the last owner's reported checkouts", async () => {
      alreadyThere(null);

      await registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID });

      expect(findOneAndUpdate.mock.calls[0][1].$set.repos).toEqual([]);
      expect(findOneAndUpdate.mock.calls[0][1].$set.bindingError).toBe("");
    });

    it("leaves a first registration's fields alone", async () => {
      await registerWorker({ name: "rig", host: "mac.home", platform: "", version: "", ownerId: OWNER_ID });

      expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("repos");
    });
  });
});

describe("the owner's reach, not the reported repos", () => {
  const reported = [{ remote: REMOTE, path: "/repo" }];

  it("refuses a project this machine's owner cannot reach", () => {
    const verdict = verdictFor(worker(), project(), PROTOCOL_VERSION, fresh, [], ["someone-else"]);

    expect(verdict).toEqual({
      ok: false,
      reason: "this machine's owner cannot reach this project",
    });
  });

  it("refuses a machine whose owner reaches nothing", () => {
    expect(verdictFor(worker(), project(), PROTOCOL_VERSION, fresh, [], []).ok).toBe(false);
  });

  it("admits an owner under no restriction at all", () => {
    expect(verdictFor(worker(), project(), PROTOCOL_VERSION, fresh, [], null)).toEqual({ ok: true });
  });

  it("offers no assignment for a project outside the owner's reach", () => {
    expect(assignmentsFor(reported, [project()], [])).toEqual([]);
    expect(assignmentsFor(reported, [project()], ["other"])).toEqual([]);
  });
});

describe("ownerReachableProjectIds", () => {
  beforeEach(() => {
    userFindById.mockReset();
    grantFind.mockReset();
    grantFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  });

  it("reaches nothing for a machine with no owner", async () => {
    expect(await ownerReachableProjectIds({ owner: null })).toEqual([]);
    expect(userFindById).not.toHaveBeenCalled();
  });

  it("reaches nothing when the owner's account is gone", async () => {
    userFindById.mockResolvedValue(null);

    expect(await ownerReachableProjectIds({ owner: "6a732075133f935b19154cd2" } as never)).toEqual([]);
  });

  it("reaches exactly the projects its owner is granted", async () => {
    userFindById.mockResolvedValue({ _id: "u1", role: "user" });
    grantFind.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([{ object: PROJECT_ID }, { object: "p2" }]) }),
    });

    expect(await ownerReachableProjectIds({ owner: "u1" } as never)).toEqual([PROJECT_ID, "p2"]);
  });

  it("is unrestricted when its owner is an instance admin", async () => {
    userFindById.mockResolvedValue({ _id: "u1", role: "admin" });

    expect(await ownerReachableProjectIds({ owner: "u1" } as never)).toBeNull();
  });
});

describe("assignmentsFor", () => {
  const reported = [{ remote: REMOTE, path: "/repo" }];

  it("offers an enabled project whose repository this machine has", () => {
    expect(assignmentsFor(reported, [project()], [PROJECT_ID])).toEqual([
      { project: PROJECT_ID, remote: REMOTE, policy: {} },
    ]);
  });

  it("answers with the remote the worker reported, never a path", () => {
    const [assignment] = assignmentsFor(reported, [project()], [PROJECT_ID]);

    expect(assignment.remote).toBe(REMOTE);
    expect(Object.keys(assignment).sort()).toEqual(["policy", "project", "remote"]);
  });

  it("skips a project nobody enabled for workers", () => {
    const off = project({ worker: { enabled: false, policy: {}, policyOverrides: [] } });

    expect(assignmentsFor(reported, [off], [PROJECT_ID])).toEqual([]);
  });

  it("skips a project whose repository this machine does not have", () => {
    expect(assignmentsFor([{ remote: "git@github.com:someone/else.git", path: "/x" }], [project()], [PROJECT_ID]))
      .toEqual([]);
  });

  it("carries only the policy fields the project's operator actually set", () => {
    const configured = project({
      worker: {
        enabled: true,
        policy: { taskTimeoutMs: 900000, model: "haiku", baseBranch: "main" },
        policyOverrides: ["taskTimeoutMs", "model"],
      },
    });

    expect(assignmentsFor(reported, [configured], [PROJECT_ID])[0].policy).toEqual({
      taskTimeoutMs: 900000,
      model: "haiku",
    });
  });

  it("offers several projects to one machine when it has all their checkouts", () => {
    const other = project({ _id: "p2", githubRepo: "owner/other" });
    const both = [
      { remote: REMOTE, path: "/repo" },
      { remote: "git@github.com:owner/other.git", path: "/other" },
    ];

    expect(assignmentsFor(both, [project(), other], [PROJECT_ID, "p2"]).map((a) => a.project)).toEqual([
      PROJECT_ID,
      "p2",
    ]);
  });

  it("offers nothing to a machine reaching nothing, whatever it would otherwise match", () => {
    expect(assignmentsFor(reported, [project()], [])).toEqual([]);
  });

  it("offers every enabled, matching project when there is no restriction", () => {
    expect(assignmentsFor(reported, [project()], null).map((a) => a.project)).toEqual([PROJECT_ID]);
  });
});

describe("contested checkouts", () => {
  const REPO = { remote: REMOTE, path: "/repo" };
  const claimant = (over: Record<string, unknown> = {}) => ({
    _id: "w1",
    name: "first",
    host: "mac.home",
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: fresh,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    repos: [REPO],
    ...over,
  });

  it("makes exactly one of two live claimants lose the checkout", () => {
    const older = claimant({ _id: "w1", name: "older", createdAt: new Date("2026-01-01") });
    const newer = claimant({ _id: "w2", name: "newer", createdAt: new Date("2026-02-01") });

    expect(lostCheckouts(older, [newer], now).size).toBe(0);
    expect(lostCheckouts(newer, [older], now)).toEqual(new Map([["/repo", "older"]]));
  });

  it("breaks a same-millisecond tie on id, so both sides agree who won", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const a = claimant({ _id: "aaa", name: "a", createdAt: at });
    const b = claimant({ _id: "bbb", name: "b", createdAt: at });

    expect(lostCheckouts(a, [b], now).size).toBe(0);
    expect(lostCheckouts(b, [a], now).size).toBe(1);
  });

  it("leaves the same path alone on a different machine, where it is a different directory", () => {
    const elsewhere = claimant({ _id: "w2", name: "other", host: "other-laptop" });

    expect(lostCheckouts(claimant({ _id: "w1" }), [elsewhere], now).size).toBe(0);
  });

  it("hands the checkout over once the earlier process goes stale", () => {
    const stale = claimant({
      _id: "w0",
      name: "gone",
      createdAt: new Date("2020-01-01"),
      lastSeenAt: new Date(now.getTime() - WORKER_STALE_MS - 1),
    });

    expect(lostCheckouts(claimant({ _id: "w2" }), [stale], now).size).toBe(0);
  });

  it("keeps every uncontested checkout when one is lost", () => {
    const other = { remote: "git@github.com:owner/other.git", path: "/other" };
    const mine = claimant({ _id: "w2", createdAt: new Date("2026-02-01"), repos: [REPO, other] });
    const older = claimant({ _id: "w1", name: "older", createdAt: new Date("2026-01-01") });

    expect(usableRepos(mine, [older], now)).toEqual([other]);
  });

  it("does not let a disabled worker keep a checkout", () => {
    const disabled = claimant({ _id: "w1", name: "off", enabled: false, createdAt: new Date("2020-01-01") });

    expect(lostCheckouts(claimant({ _id: "w2" }), [disabled], now).size).toBe(0);
  });
});

describe("verdictFor and a contested checkout", () => {
  const older = {
    _id: "w0",
    name: "older",
    host: "mac.home",
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: fresh,
    createdAt: new Date("2020-01-01"),
    repos: [{ remote: REMOTE, path: "/repo" }],
  };

  it("refuses the loser and names the machine holding the checkout", () => {
    const loser = worker({ _id: "w2", createdAt: new Date("2026-06-01") });

    const verdict = verdictFor(loser, project(), PROTOCOL_VERSION, now, [older] as never);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/older already runs this checkout/i);
  });

  it("still admits the winner", () => {
    const winner = worker({ _id: "w0", createdAt: new Date("2019-01-01") });

    expect(verdictFor(winner, project(), PROTOCOL_VERSION, now, [older] as never)).toEqual({ ok: true });
  });
});

describe("overriddenWorkerPolicy", () => {
  it("sends nothing at all when the operator has set nothing", () => {
    expect(overriddenWorkerPolicy(worker({ policy: { pollIntervalMs: 5000 }, policyOverrides: [] })))
      .toEqual({});
  });

  it("sends only the fields the operator actually set", () => {
    expect(
      overriddenWorkerPolicy(
        worker({ policy: { pollIntervalMs: 5000 }, policyOverrides: ["pollIntervalMs"] })
      )
    ).toEqual({ pollIntervalMs: 5000 });
  });

  it("never sends a field that is no longer a machine setting", () => {
    const legacy = worker({
      policy: { pollIntervalMs: 5000, model: "haiku", taskTimeoutMs: 900000 },
      policyOverrides: ["pollIntervalMs", "model", "taskTimeoutMs"],
    });

    expect(overriddenWorkerPolicy(legacy)).toEqual({ pollIntervalMs: 5000 });
  });
});

describe("offersFor", () => {
  const OTHER_ID = "69a52e3b399b27d3cbb2c5a6";
  const reported = [{ remote: REMOTE, path: "/repo" }];

  function candidate(overrides: Record<string, unknown> = {}) {
    return project({ _id: OTHER_ID, key: "SB", name: "Sandbox", githubRepo: "owner/sandbox", ...overrides });
  }

  it("offers a project this machine could serve but has no checkout of", () => {
    expect(offersFor(reported, [candidate()], [OTHER_ID])).toEqual([
      {
        project: OTHER_ID,
        key: "SB",
        name: "Sandbox",
        repositoryUrl: "https://github.com/owner/sandbox",
      },
    ]);
  });

  it("says nothing about a project whose checkout this machine already reports", () => {
    expect(offersFor(reported, [project({ key: "BP", name: "Board Planner" })], [PROJECT_ID])).toEqual([]);
  });

  it("offers nothing the assignment itself would refuse", () => {
    expect(offersFor(reported, [candidate({ worker: { enabled: false } })], [OTHER_ID])).toEqual([]);
    expect(offersFor(reported, [candidate()], [])).toEqual([]);
    expect(offersFor(reported, [candidate()], ["somebody-elses-project"])).toEqual([]);
  });

  it("offers nothing for a project that names no repository, since there is nothing to clone", () => {
    expect(offersFor(reported, [candidate({ githubRepo: "", repositoryUrl: "" })], [OTHER_ID])).toEqual([]);
  });

  it("offers nothing to a machine whose owner reaches nothing", () => {
    expect(offersFor(reported, [candidate()], [])).toEqual([]);
  });

  it("reaches everything for an unrestricted owner, the way an assignment does", () => {
    expect(offersFor(reported, [candidate()], null)).toHaveLength(1);
  });
});

describe("catalogueFor", () => {
  const OTHER_ID = "69a52e3b399b27d3cbb2c5a6";
  const NO_REPO_ID = "69a52e3b399b27d3cbb2c5a7";
  const reported = [{ remote: REMOTE, path: "/repo" }];

  const served = () => project({ key: "BP", name: "Board Planner" });
  const candidate = () =>
    project({ _id: OTHER_ID, key: "SB", name: "Sandbox", githubRepo: "owner/sandbox" });
  const switchedOff = () =>
    project({
      _id: OTHER_ID,
      key: "SB",
      name: "Sandbox",
      githubRepo: "owner/sandbox",
      worker: { enabled: false },
    });
  const noRepo = () =>
    project({ _id: NO_REPO_ID, key: "MC", name: "Mocci", githubRepo: "", repositoryUrl: "" });

  it("marks a project this machine serves as connected", () => {
    const [row] = catalogueFor(reported, [served()], [PROJECT_ID], undefined);

    expect(row).toMatchObject({
      project: PROJECT_ID,
      key: "BP",
      name: "Board Planner",
      workersEnabled: true,
      servedHere: true,
      available: true,
    });
  });

  it("lists a project whose workers are switched off, and says so", () => {
    const [row] = catalogueFor(reported, [switchedOff()], [OTHER_ID], undefined);

    expect(row).toMatchObject({ key: "SB", workersEnabled: false, servedHere: false, available: true });
  });

  it("lists a project that names no repository as unavailable", () => {
    const [row] = catalogueFor(reported, [noRepo()], [NO_REPO_ID], undefined);

    expect(row).toMatchObject({ key: "MC", available: false, repositoryUrl: "" });
  });

  it("says nothing about a project outside the owner's reach", () => {
    expect(catalogueFor(reported, [candidate()], [], undefined)).toEqual([]);
    expect(catalogueFor(reported, [candidate()], ["somebody-else"], undefined)).toEqual([]);
  });

  it("treats a machine that has never used the screen as wanting what it already serves", () => {
    const rows = catalogueFor(reported, [served(), candidate()], null, undefined);

    expect(rows.find((r) => r.key === "BP")).toMatchObject({ servedHere: true, wanted: true });
    expect(rows.find((r) => r.key === "SB")).toMatchObject({ servedHere: false, wanted: false });
  });

  it("reads the stored selection once there is one", () => {
    const rows = catalogueFor(reported, [served(), candidate()], null, [OTHER_ID]);

    expect(rows.find((r) => r.key === "SB")).toMatchObject({ servedHere: false, wanted: true });
    expect(rows.find((r) => r.key === "BP")).toMatchObject({ servedHere: true, wanted: false });
  });

  it("counts a checkout the operator added by hand as connected, rather than offering a second clone", () => {
    const elsewhere = [{ remote: "git@github.com:owner/repo.git", path: "/somewhere/of/my/own" }];

    expect(catalogueFor(elsewhere, [served()], [PROJECT_ID], undefined)[0]).toMatchObject({
      servedHere: true,
    });
  });
});
