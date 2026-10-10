import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ budget: null as unknown, rows: [] as Record<string, unknown>[], trial: false, locked: null as Date | null }));

vi.mock("./limits", () => ({ budgetOf: async () => m.budget }));
vi.mock("./budget", () => ({ counterKindOf: async () => (m.trial ? "trial" : "month") }));
vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({ aiLockedAt: m.locked }) }));

const { aiUsageSummary } = await import("./summary");

const NOW = new Date("2026-10-09T10:00:00Z");
const find = vi.fn();
const db = { organisation: "org", AiBudget: { find: (filter: unknown) => (find(filter), { lean: async () => m.rows }) } } as never;

beforeEach(() => {
  m.budget = { scope: "month", limit: 15_000_000, dailyCeiling: 3_000_000 };
  m.rows = [];
  m.trial = false;
  m.locked = null;
  find.mockClear();
});

// BP-680: what an organisation has used of what it may spend, for its own Settings and for the operator
describe("aiUsageSummary", () => {
  it("reports the month's tokens against the allowance, today's against the ceiling, and when the month renews", async () => {
    m.rows = [
      { kind: "month", period: "2026-10", tokens: 4_200_000, ownTokens: 77_000 },
      { kind: "day", period: "2026-10-09", tokens: 900_000, ownTokens: 5 },
    ];

    expect(await aiUsageSummary(db, NOW)).toEqual({
      scope: "month",
      used: 4_200_000,
      limit: 15_000_000,
      resetsAt: "2026-11-01T00:00:00.000Z",
      today: 900_000,
      dailyCeiling: 3_000_000,
      ownTokens: 77_000,
      locked: false,
    });
    expect(find).toHaveBeenCalledWith({ $or: [{ kind: "day", period: "2026-10-09" }, { kind: "month", period: "2026-10" }] });
  });

  it("reads a trial from its own counter, which does not renew", async () => {
    m.budget = { scope: "trial", limit: 3_000_000, dailyCeiling: 600_000 };
    m.rows = [{ kind: "trial", period: "all", tokens: 1_000_000, ownTokens: 0 }];

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ scope: "trial", used: 1_000_000, limit: 3_000_000, resetsAt: null, dailyCeiling: 600_000 });
    expect(find).toHaveBeenCalledWith({ $or: [{ kind: "day", period: "2026-10-09" }, { kind: "trial", period: "all" }] });
  });

  it("still counts where nothing limits it: no limit, no ceiling, no renewal to name", async () => {
    m.budget = null;
    m.rows = [{ kind: "month", period: "2026-10", tokens: 12_345, ownTokens: 0 }];

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ scope: "month", used: 12_345, limit: null, dailyCeiling: null });
  });

  it("reads a trial's counter where there is no limit too, which is the one the calls are added to", async () => {
    m.budget = null;
    m.trial = true;

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ scope: "trial", used: 0 });
  });

  it("says whether the operator has switched the key off", async () => {
    m.locked = new Date();

    expect((await aiUsageSummary(db, NOW)).locked).toBe(true);
  });

  it("reads a day or a month with nothing counted as zero", async () => {
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ used: 0, today: 0, ownTokens: 0 });
  });
});
