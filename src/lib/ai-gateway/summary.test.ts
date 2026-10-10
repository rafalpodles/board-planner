import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ budget: null as unknown, rows: [] as Record<string, unknown>[], trial: false, locked: null as Date | null, allowance: undefined as unknown, hosted: true, managed: true }));

vi.mock("./limits", async () => ({ ...(await vi.importActual<typeof import("./limits")>("./limits")), budgetOf: async () => m.budget }));
vi.mock("./budget", () => ({ counterKindOf: async () => (m.trial ? "trial" : "month") }));
vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({ aiLockedAt: m.locked, aiAllowance: m.allowance }) }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => (m.hosted ? "board-planner.com" : null) }));
vi.mock("@/lib/entitlements", () => ({ can: () => m.managed }));

const { aiUsageSummary } = await import("./summary");

const NOW = new Date("2026-10-09T10:00:00Z");
const find = vi.fn();
const db = { organisation: "org", AiBudget: { find: (filter: unknown) => (find(filter), { lean: async () => m.rows }) } } as never;

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-x");
  m.budget = { scope: "month", limit: 15_000_000, dailyCeiling: 3_000_000 };
  m.rows = [];
  m.trial = false;
  m.locked = null;
  m.allowance = undefined;
  m.hosted = true;
  m.managed = true;
  find.mockClear();
});

afterEach(() => vi.unstubAllEnvs());

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
      overridden: false,
      included: true,
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

  it("shows no daily ceiling where the allowance has none, rather than a ceiling of nothing", async () => {
    m.budget = { scope: "month", limit: 1_000_000, dailyCeiling: 0 };

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ limit: 1_000_000, dailyCeiling: null });
  });

  it("reads a trial's counter where there is no limit too, which is the one the calls are added to", async () => {
    m.budget = null;
    m.trial = true;

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ scope: "trial", used: 0 });
  });

  it("gives a hosted organisation on a plan without managed AI no allowance, since the key is its own or nothing", async () => {
    m.managed = false;
    m.rows = [{ kind: "month", period: "2026-10", tokens: 0, ownTokens: 500 }];

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ included: false, limit: null, dailyCeiling: null, ownTokens: 500 });
  });

  it("has no allowance where the service has no key to offer, whatever the plan says", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ included: false, limit: null });
  });

  it("keeps a self-hosted instance's own key included, whatever the plan says", async () => {
    m.hosted = false;
    m.managed = false;

    expect(await aiUsageSummary(db, NOW)).toMatchObject({ included: true });
  });

  it("says whether the operator has switched the key off", async () => {
    m.locked = new Date();

    expect((await aiUsageSummary(db, NOW)).locked).toBe(true);
  });

  it("reads a day or a month with nothing counted as zero", async () => {
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ used: 0, today: 0, ownTokens: 0 });
  });

  // BP-678
  it("says whether the operator's own figure is the one in force, which it is only on the counter it was set on", async () => {
    m.allowance = { tokens: 2_000_000, scope: "month" };
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ overridden: true });

    m.allowance = { tokens: null, scope: "month" };
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ overridden: true });

    m.allowance = { tokens: 2_000_000, scope: "trial" };
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ overridden: false });

    m.allowance = { tokens: 0, scope: "month" };
    expect(await aiUsageSummary(db, NOW)).toMatchObject({ overridden: false });
  });
});
