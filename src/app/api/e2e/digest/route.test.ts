import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const digestTick = vi.fn().mockResolvedValue(3);
vi.mock("@/lib/digest", () => ({ digestTick: () => digestTick() }));

const mounted = vi.fn();
vi.mock("@/lib/e2e-only", () => ({
  e2eOnlyMounted: (...args: unknown[]) => mounted(...args),
}));

const { POST } = await import("./route");

/**
 * BP-605. The route exists so a spec can produce a digest on demand, and it sends real mail to
 * every subscriber who has one waiting. Nothing authenticates it, so the environment is the whole
 * of the gate.
 *
 * Three tests for two halves. `e2e-only.test.ts` pins what the gate answers across the matrix; the
 * last test here pins that this route asks it about the live environment. Without that one, a
 * handler passing a literal `"development"` — or reading a fumbled variable name, which yields
 * `undefined` — answers 200 on a production deployment carrying a stray `E2E=1` with every unit
 * test still green (BP-605 review).
 */
describe("POST /api/e2e/digest", () => {
  beforeEach(() => {
    digestTick.mockClear();
    mounted.mockClear();
  });
  afterEach(() => delete process.env.E2E);

  it("runs a tick when the gate is open", async () => {
    mounted.mockReturnValue(true);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 3 });
    expect(digestTick).toHaveBeenCalledTimes(1);
  });

  // Not called, rather than called and its answer discarded: a tick sends mail and claims the day
  // in `lastDigestDay`, so a refusal that runs it first has already done what it refused.
  it("is not there when the gate is shut, and does not tick", async () => {
    mounted.mockReturnValue(false);

    const response = await POST();

    expect(response.status).toBe(404);
    expect(digestTick).not.toHaveBeenCalled();
  });

  it("asks the gate about this process's own environment, not a literal", async () => {
    mounted.mockReturnValue(false);
    process.env.E2E = "not-the-suite";
    // The premise this assertion rests on: vitest runs at NODE_ENV "test", so a handler that
    // hardcoded "development" — or read nothing — is a different value from the one passed here.
    // Were it empty, both sides would read undefined and the test would pin nothing.
    expect(process.env.NODE_ENV, "vitest is expected to set NODE_ENV").toBeTruthy();

    await POST();

    expect(mounted).toHaveBeenCalledWith(process.env.E2E, process.env.NODE_ENV);
  });
});
