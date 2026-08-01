import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/worker", () => ({ Worker: { findById, findOneAndUpdate, updateOne } }));

const { verdictFor, verifyWorkerCredential, PROTOCOL_VERSION, WORKER_STALE_MS, WORKER_HEARTBEAT_MS } =
  await import("./worker-service");

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

  it("compares the project as a string, so an ObjectId assignment matches a resolved id", () => {
    const assignments = [{ project: { toString: () => project }, proposedPath: "/repo" }];

    expect(verdictFor(worker({ assignments }), project, PROTOCOL_VERSION, now)).toEqual({ ok: true });
  });

  // A worker heartbeating every WORKER_STALE_MS would race its own staleness check
  it("heartbeats comfortably inside the staleness window", () => {
    expect(WORKER_HEARTBEAT_MS * 2).toBeLessThan(WORKER_STALE_MS);
  });
});

describe("verifyWorkerCredential", () => {
  beforeEach(() => findById.mockReset());

  // An unauthenticated request must not be able to throw a CastError through the handler
  it("rejects a malformed worker id without touching the database", async () => {
    expect(await verifyWorkerCredential("not-an-object-id", "cpw_x")).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects an unknown worker", async () => {
    findById.mockResolvedValue(null);

    expect(await verifyWorkerCredential("69a52e3b399b27d3cbb2c5a5", "cpw_x")).toBeNull();
  });
});
