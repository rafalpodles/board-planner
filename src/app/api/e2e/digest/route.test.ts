import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const digestTick = vi.fn().mockResolvedValue(3);
vi.mock("@/lib/digest", () => ({ digestTick: () => digestTick() }));

const { POST } = await import("./route");

/**
 * BP-605. The route exists so a spec can produce a digest on demand, and it sends real mail to
 * every subscriber who has one waiting. Nothing authenticates it, so the environment is the whole
 * of the gate.
 *
 * `NODE_ENV` is left alone here — `e2e-only.test.ts` pins the matrix by value, and vitest's own
 * "test" is one of the environments where the gate is open, so these two cases turn entirely on
 * `E2E`. Stubbing `NODE_ENV` instead would be shared mutable state: `process.env` is one object
 * per worker, and another file's `unstubAllEnvs` lands mid-await.
 */
describe("POST /api/e2e/digest", () => {
  beforeEach(() => digestTick.mockClear());
  afterEach(() => delete process.env.E2E);

  it("runs a tick under the e2e environment", async () => {
    process.env.E2E = "1";

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 3 });
    expect(digestTick).toHaveBeenCalledTimes(1);
  });

  // Not called, rather than called and its answer discarded: a tick sends mail and claims the day
  // in `lastDigestDay`, so a refusal that runs it first has already done what it refused.
  it("is not there at all without E2E, and does not tick", async () => {
    delete process.env.E2E;

    const response = await POST();

    expect(response.status).toBe(404);
    expect(digestTick).not.toHaveBeenCalled();
  });
});
