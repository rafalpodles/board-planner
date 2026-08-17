import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, updateOne } }));

const {
  assignmentsFor,
  lostCheckouts,
  usableRepos,
  overriddenWorkerPolicy,
  verdictFor,
  verifyWorkerCredential,
  PROTOCOL_VERSION,
  WORKER_STALE_MS,
  WORKER_HEARTBEAT_MS,
} = await import("./worker-service");

const now = new Date("2026-08-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 1000);
const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const REMOTE = "git@github.com:owner/repo.git";

// A project the worker may serve: enabled, and naming a repository this machine reports.
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
    // BP-305: what an admin approved. The reported repos narrow this, they never define it.
    approvedProjects: [PROJECT_ID],
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

  // The version the request speaks, not the one frozen into the record at registration --
  // otherwise a worker upgraded after a server bump is rejected forever with no way back
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

  // new Date("not-a-date").getTime() is NaN, and NaN > WORKER_STALE_MS is false --
  // the old `> WORKER_STALE_MS` check failed open on an unparseable timestamp
  it("refuses a worker whose lastSeenAt does not parse as a date", () => {
    const verdict = verdictFor(worker({ lastSeenAt: "not-a-date" }), project(), PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/reported/i);
  });


  // String(undefined) === String(undefined): a caller passing no project id must not match
  // an assignment that also has no project, however that assignment came to be malformed
  // A project that could not be loaded must refuse, not fall through to "assigned"
  it("refuses when the project could not be resolved at all", () => {
    const verdict = verdictFor(worker(), null, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/not enabled/i);
  });

  // The project names a repository this machine does not have, so being enabled is not enough
  it("refuses an enabled project whose repository this machine lacks", () => {
    const verdict = verdictFor(worker(), project({ githubRepo: "someone/else" }), PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/no checkout/i);
  });

  // A project naming no repository must never match the first checkout a machine happens to have
  it("refuses a project that names no repository at all", () => {
    const nameless = project({ githubRepo: "", gitlabRepo: "" });

    expect(verdictFor(worker(), nameless, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  // A worker heartbeating every WORKER_STALE_MS would race its own staleness check
  it("heartbeats comfortably inside the staleness window", () => {
    expect(WORKER_HEARTBEAT_MS * 2).toBeLessThan(WORKER_STALE_MS);
  });

  // The enrolment screen says "The machine acts under this account". Until BP-358 that was a display
  // name; a machine enrolled before it has no owner, and there is no safe guess — a fallback to the
  // old project-wide nominee would keep the race it replaces alive indefinitely.
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

  // An unauthenticated request must not be able to throw a CastError through the handler
  it("rejects a malformed worker id without touching the database", async () => {
    expect(await verifyWorkerCredential("not-an-object-id", "cpw_x")).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  // bcryptjs rejects its returned promise on a non-string argument -- without this guard
  // that becomes an unhandled rejection instead of a clean refusal
  it("rejects a non-string credential without touching the database", async () => {
    expect(await verifyWorkerCredential(workerId, undefined as unknown as string)).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker", async () => {
    findById.mockReturnValue({ select: () => Promise.resolve(null) });

    expect(await verifyWorkerCredential(workerId, "cpw_x")).toBeNull();
  });

  // credentialHash is select: false on the schema; a plain findById would compare against
  // undefined and reject every valid credential
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

// Two live workers pointed at the same checkout both create worktrees in it and both run `git` in
// it. The claim is atomic so they will not take the same task, but the working tree is not — one
// run's checkout moves under the other's feet.
// Assignment is no longer stored: it is the project being enabled AND this machine reporting a
// checkout of its repository. Nothing the server writes decides it.
// BP-305: a remote is public information and the worker reports its own, so approval for one
// project must not become approval for every enabled one
describe("the approved set, not the reported repos", () => {
  it("refuses a project this worker was never approved for", () => {
    const verdict = verdictFor(
      worker({ approvedProjects: ["someone-else"] }),
      project(),
      PROTOCOL_VERSION,
      fresh
    );

    expect(verdict).toEqual({ ok: false, reason: "this worker was not approved for this project" });
  });

  it("refuses a worker approved for nothing, which is what a pre-BP-305 enrolment is", () => {
    const verdict = verdictFor(worker({ approvedProjects: [] }), project(), PROTOCOL_VERSION, fresh);

    expect(verdict.ok).toBe(false);
  });

  it("offers no assignment for a project outside the approved set", () => {
    const reported = [{ remote: REMOTE, path: "/repo" }];

    expect(assignmentsFor(reported, [project()], [])).toEqual([]);
    expect(assignmentsFor(reported, [project()], ["other"])).toEqual([]);
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
});

// Two machines each serving the same project is fine and useful — the claim is atomic. The real
// hazard is two worker processes on ONE machine sharing a working tree.
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

  // The bug this replaced: the old predicate was symmetric, so both processes stood down and both
  // machines idled with a green console.
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

  // A disabled or locked worker is not running, so it must not hold a checkout hostage
  it("does not let a disabled worker keep a checkout", () => {
    const disabled = claimant({ _id: "w1", name: "off", enabled: false, createdAt: new Date("2020-01-01") });

    expect(lostCheckouts(claimant({ _id: "w2" }), [disabled], now).size).toBe(0);
  });
});

// The claim has to be refused too, not merely the assignment withheld: an assignment the worker
// already holds from an earlier refresh would otherwise still let it claim into a shared tree.
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

// The point of tracking overrides: a field nobody set must follow the default, so raising a default
// reaches every worker that never pinned it. Sending the whole stored policy defeats that — the
// worker's applyPolicy takes every field present and the default never wins again.
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

  // Work policy belongs to the project now; a stray copy on a worker document must not travel
  it("never sends a field that is no longer a machine setting", () => {
    const legacy = worker({
      policy: { pollIntervalMs: 5000, model: "haiku", taskTimeoutMs: 900000 },
      policyOverrides: ["pollIntervalMs", "model", "taskTimeoutMs"],
    });

    expect(overriddenWorkerPolicy(legacy)).toEqual({ pollIntervalMs: 5000 });
  });
});
