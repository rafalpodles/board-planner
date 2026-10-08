import { describe, it, expect, vi, beforeEach } from "vitest";

const sweep = vi.fn().mockResolvedValue({ looked: 1, noticed: 0, cleared: 0, suspended: 0, deleted: 0 });
vi.mock("@/lib/dead-organisations", () => ({ sweepDeadOrganisations: (...args: unknown[]) => sweep(...args) }));

const mounted = vi.fn();
vi.mock("@/lib/e2e-only", () => ({ e2eOnlyMounted: (...args: unknown[]) => mounted(...args) }));

const { POST } = await import("./route");

const post = (body: unknown = {}) => POST(new Request("http://x/api/e2e/dead-organisations", { method: "POST", body: JSON.stringify(body) }));

// BP-674: the route deletes organisations on a clock it chooses, and nothing authenticates it, so the environment is the whole gate
describe("POST /api/e2e/dead-organisations", () => {
  beforeEach(() => {
    sweep.mockClear();
    mounted.mockReset();
  });

  it("is not there when the gate is shut, and sweeps nothing", async () => {
    mounted.mockReturnValue(false);

    expect((await post({ daysFromNow: 90 })).status).toBe(404);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("asks the gate about the live environment", async () => {
    mounted.mockReturnValue(false);
    process.env.E2E = "1";
    await post();
    delete process.env.E2E;

    expect(mounted).toHaveBeenCalledWith("1", process.env.NODE_ENV);
  });

  it("sweeps with the clock moved forward when it is open", async () => {
    mounted.mockReturnValue(true);
    const before = Date.now();

    const res = await post({ daysFromNow: 2, minutesFromNow: 5, days: 45 });

    expect(res.status).toBe(200);
    const [now, days] = sweep.mock.calls[0] as [number, number];
    expect(days).toBe(45);
    expect(now - before).toBeGreaterThanOrEqual(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000);
  });
});
