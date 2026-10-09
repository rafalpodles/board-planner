import { describe, it, expect, vi, beforeEach } from "vitest";

const run = vi.fn().mockResolvedValue({ skipped: 0, unchanged: 0, sent: 1, failed: 0, waiting: 0 });
vi.mock("@/lib/member-sync", () => ({ runMemberSync: (...args: unknown[]) => run(...args) }));

const mounted = vi.fn();
vi.mock("@/lib/e2e-only", () => ({ e2eOnlyMounted: (...args: unknown[]) => mounted(...args) }));

const { POST } = await import("./route");

const post = (body: unknown = {}) => POST(new Request("http://x/api/e2e/member-sync", { method: "POST", body: JSON.stringify(body) }));

// BP-982: the route tells the licence service the people of every organisation on a clock it chooses, and nothing authenticates it
describe("POST /api/e2e/member-sync", () => {
  beforeEach(() => {
    run.mockClear();
    mounted.mockReset();
  });

  it("is not there when the gate is shut, and syncs nothing", async () => {
    mounted.mockReturnValue(false);

    expect((await post({ minutesFromNow: 5 })).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the gate about the live environment", async () => {
    mounted.mockReturnValue(false);
    process.env.E2E = "1";
    await post();
    delete process.env.E2E;

    expect(mounted).toHaveBeenCalledWith("1", process.env.NODE_ENV);
  });

  it("syncs with the clock moved forward when it is open, so a pause after a failure is not waited out", async () => {
    mounted.mockReturnValue(true);
    const before = Date.now();

    const res = await post({ minutesFromNow: 5 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1 });
    expect((run.mock.calls[0][0] as number) - before).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});
