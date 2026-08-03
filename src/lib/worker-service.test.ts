import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, updateOne } }));

const {
  collidingAssignment,
  verdictFor,
  verifyWorkerCredential,
  PROTOCOL_VERSION,
  WORKER_STALE_MS,
  WORKER_HEARTBEAT_MS,
} = await import("./worker-service");

const now = new Date("2026-08-01T12:00:00.000Z");
const fresh = new Date(now.getTime() - 1000);
const project = "69a52e3b399b27d3cbb2c5a5";

function worker(overrides: Record<string, unknown> = {}) {
  return {
    _id: "w1",
    enabled: true,
    lockedByInstance: false,
    protocolVersion: PROTOCOL_VERSION,
    lastSeenAt: fresh,
    assignments: [{ project, proposedPath: "/repo" }],
    ...overrides,
  } as never;
}

describe("verdictFor", () => {
  it("admits a healthy worker assigned to the project", () => {
    expect(verdictFor(worker(), project, PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  it.each([
    ["disabled", { enabled: false }, /disabled/i],
    ["locked by the instance", { lockedByInstance: true }, /locked/i],
    ["not assigned to the project", { assignments: [] }, /assign/i],
  ])("refuses a worker %s", (_label, overrides, pattern) => {
    const verdict = verdictFor(worker(overrides), project, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(pattern);
  });

  // The version the request speaks, not the one frozen into the record at registration --
  // otherwise a worker upgraded after a server bump is rejected forever with no way back
  it("refuses a request speaking an older protocol", () => {
    expect(verdictFor(worker(), project, PROTOCOL_VERSION - 1, now).ok).toBe(false);
  });

  it("refuses a request with no protocol at all", () => {
    const verdict = verdictFor(worker(), project, NaN, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/protocol/i);
  });

  it("refuses a worker that has stopped heartbeating", () => {
    const stale = new Date(now.getTime() - WORKER_STALE_MS - 1);

    expect(verdictFor(worker({ lastSeenAt: stale }), project, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  it("refuses a worker that has never heartbeaten", () => {
    expect(verdictFor(worker({ lastSeenAt: null }), project, PROTOCOL_VERSION, now).ok).toBe(false);
  });

  // new Date("not-a-date").getTime() is NaN, and NaN > WORKER_STALE_MS is false --
  // the old `> WORKER_STALE_MS` check failed open on an unparseable timestamp
  it("refuses a worker whose lastSeenAt does not parse as a date", () => {
    const verdict = verdictFor(worker({ lastSeenAt: "not-a-date" }), project, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/reported/i);
  });

  it("compares the project as a string, so an ObjectId assignment matches a resolved id", () => {
    const assignments = [{ project: { toString: () => project }, proposedPath: "/repo" }];

    expect(verdictFor(worker({ assignments }), project, PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  // String(undefined) === String(undefined): a caller passing no project id must not match
  // an assignment that also has no project, however that assignment came to be malformed
  it("refuses when the caller supplies no project id, even if an assignment has none either", () => {
    const assignments = [{ proposedPath: "/repo" }];
    const verdict = verdictFor(worker({ assignments }), undefined as unknown as string, PROTOCOL_VERSION, now);

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/assign/i);
  });

  it("never matches an assignment with no project, even against a truthy project id", () => {
    const assignments = [{ proposedPath: "/repo" }];

    expect(verdictFor(worker({ assignments }), "undefined", PROTOCOL_VERSION, now).ok).toBe(false);
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
describe("collidingAssignment", () => {
  const other = "6a705baf749036e9ae754e1c";

  function fleet(overrides: Record<string, unknown> = {}) {
    return [worker({ _id: "w2", name: "other-laptop", ...overrides })];
  }

  it("passes when nothing else holds the project and path", () => {
    expect(collidingAssignment([{ project: other, proposedPath: "/repo" }], fleet(), now)).toBeNull();
  });

  it("refuses a second live worker on the same project and path", () => {
    const collision = collidingAssignment([{ project, proposedPath: "/repo" }], fleet(), now);

    expect(collision?.workerName).toBe("other-laptop");
    expect(collision?.assignment).toEqual({ project, proposedPath: "/repo" });
  });

  it("allows the same project in a different checkout", () => {
    expect(collidingAssignment([{ project, proposedPath: "/other-repo" }], fleet(), now)).toBeNull();
  });

  it("allows the same checkout for a different project", () => {
    expect(
      collidingAssignment([{ project: other, proposedPath: "/repo" }], fleet(), now)
    ).toBeNull();
  });

  // A worker that cannot claim is not competing for the checkout, and refusing on its account would
  // strand the operator with no way to move an assignment off a machine that is gone.
  it("ignores a disabled worker", () => {
    expect(collidingAssignment([{ project, proposedPath: "/repo" }], fleet({ enabled: false }), now))
      .toBeNull();
  });

  it("ignores a locked worker", () => {
    expect(
      collidingAssignment([{ project, proposedPath: "/repo" }], fleet({ lockedByInstance: true }), now)
    ).toBeNull();
  });

  it("ignores a worker that has not reported in", () => {
    const stale = new Date(now.getTime() - WORKER_STALE_MS - 1);

    expect(collidingAssignment([{ project, proposedPath: "/repo" }], fleet({ lastSeenAt: stale }), now))
      .toBeNull();
  });

  it("treats an unparseable lastSeenAt as stale rather than live", () => {
    expect(
      collidingAssignment([{ project, proposedPath: "/repo" }], fleet({ lastSeenAt: "not-a-date" }), now)
    ).toBeNull();
  });

  it("refuses a request that collides with itself", () => {
    const collision = collidingAssignment(
      [
        { project, proposedPath: "/repo" },
        { project, proposedPath: "/repo" },
      ],
      [],
      now
    );

    expect(collision?.assignment).toEqual({ project, proposedPath: "/repo" });
  });

  it("names the first collision when several are present", () => {
    const collision = collidingAssignment(
      [
        { project: other, proposedPath: "/free" },
        { project, proposedPath: "/repo" },
      ],
      fleet(),
      now
    );

    expect(collision?.assignment.proposedPath).toBe("/repo");
  });
});
