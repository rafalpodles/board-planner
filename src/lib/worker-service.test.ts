import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, updateOne } }));

const {
  assignmentsFor,
  sharedCheckout,
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

  it("compares the project as a string, so an ObjectId assignment matches a resolved id", () => {
    const assignments = [{ project: { toString: () => project }, proposedPath: "/repo" }];

    expect(verdictFor(worker({ assignments }), project(), PROTOCOL_VERSION, now)).toEqual({ ok: true });
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
describe("assignmentsFor", () => {
  const reported = [{ remote: REMOTE, path: "/repo" }];

  it("offers an enabled project whose repository this machine has", () => {
    expect(assignmentsFor(reported, [project()])).toEqual([
      { project: PROJECT_ID, remote: REMOTE, policy: {} },
    ]);
  });

  it("answers with the remote the worker reported, never a path", () => {
    const [assignment] = assignmentsFor(reported, [project()]);

    expect(assignment.remote).toBe(REMOTE);
    expect(Object.keys(assignment).sort()).toEqual(["policy", "project", "remote"]);
  });

  it("skips a project nobody enabled for workers", () => {
    const off = project({ worker: { enabled: false, policy: {}, policyOverrides: [] } });

    expect(assignmentsFor(reported, [off])).toEqual([]);
  });

  it("skips a project whose repository this machine does not have", () => {
    expect(assignmentsFor([{ remote: "git@github.com:someone/else.git", path: "/x" }], [project()]))
      .toEqual([]);
  });

  it("carries only the policy fields the project's operator actually set", () => {
    const configured = project({
      worker: {
        enabled: true,
        policy: { autoMerge: true, model: "haiku", baseBranch: "main" },
        policyOverrides: ["autoMerge", "model"],
      },
    });

    expect(assignmentsFor(reported, [configured])[0].policy).toEqual({
      autoMerge: true,
      model: "haiku",
    });
  });

  it("offers several projects to one machine when it has all their checkouts", () => {
    const other = project({ _id: "p2", githubRepo: "owner/other" });
    const both = [
      { remote: REMOTE, path: "/repo" },
      { remote: "git@github.com:owner/other.git", path: "/other" },
    ];

    expect(assignmentsFor(both, [project(), other]).map((a) => a.project)).toEqual([
      PROJECT_ID,
      "p2",
    ]);
  });
});

// Two machines each serving the same project is fine and useful — the claim is atomic. The real
// hazard is two worker processes on ONE machine sharing a working tree.
describe("sharedCheckout", () => {
  const live = (overrides: Record<string, unknown> = {}) =>
    worker({ name: "other", ...overrides }) as unknown as never;

  it("refuses a checkout another live worker on the same host already has", () => {
    const collision = sharedCheckout(
      { host: "mac.home", repos: [{ remote: REMOTE, path: "/repo" }] },
      [live()],
      now
    );

    expect(collision).toEqual({ path: "/repo", workerName: "other" });
  });

  it("allows the same path on a different machine, where it is a different directory", () => {
    expect(
      sharedCheckout(
        { host: "other-laptop", repos: [{ remote: REMOTE, path: "/repo" }] },
        [live()],
        now
      )
    ).toBeNull();
  });

  it("ignores a worker that has gone stale, so its checkout can be taken over", () => {
    const stale = live({ lastSeenAt: new Date(now.getTime() - WORKER_STALE_MS - 1) });

    expect(
      sharedCheckout({ host: "mac.home", repos: [{ remote: REMOTE, path: "/repo" }] }, [stale], now)
    ).toBeNull();
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
      policy: { pollIntervalMs: 5000, model: "haiku", autoMerge: true },
      policyOverrides: ["pollIntervalMs", "model", "autoMerge"],
    });

    expect(overriddenWorkerPolicy(legacy)).toEqual({ pollIntervalMs: 5000 });
  });
});
