import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  hosted: true,
  entitlements: { plan: "pro", trial: false, expiresAt: undefined as Date | undefined } as Record<string, unknown>,
  active: 10,
  pending: 0,
  allowance: undefined as unknown,
}));

vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({ entitlements: m.entitlements, aiAllowance: m.allowance }) }));
vi.mock("@/lib/member-limit", () => ({ memberCounts: async () => ({ active: m.active, pending: m.pending }) }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => (m.hosted ? "board-planner.com" : null) }));

const { aiLimitWarnings, budgetOf, limitFromEnv } = await import("./limits");

const db = { organisation: "org" } as never;

beforeEach(() => {
  m.hosted = true;
  m.entitlements = { plan: "pro", trial: false };
  m.active = 10;
  m.pending = 0;
  m.allowance = undefined;
});
afterEach(() => vi.unstubAllEnvs());

// BP-680: what an organisation may spend of the operator's key
describe("limitFromEnv", () => {
  it("is the hosted default on a hosted instance, and off on a self-hosted one, where nothing is set", () => {
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    m.hosted = false;
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(0);
  });

  it("applies anywhere once it is set, and 0 turns it off", () => {
    vi.stubEnv("AI_MONTHLY_TOKENS", "2000000");
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(2_000_000);
    m.hosted = false;
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(2_000_000);
    vi.stubEnv("AI_MONTHLY_TOKENS", "0");
    m.hosted = true;
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(0);
  });

  it("reads an empty or blank variable as unset, which is what a compose file or a dashboard leaves behind", () => {
    vi.stubEnv("AI_MONTHLY_TOKENS", "");
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    vi.stubEnv("AI_MONTHLY_TOKENS", "   ");
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
  });

  it("rounds a fraction down and refuses a negative number, saying so once however often it is read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_MONTHLY_TOKENS", "1500.7");
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(1500);

    vi.stubEnv("AI_MONTHLY_TOKENS", "-5");
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("says so and falls back to the default for a value that is not a number", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_MONTHLY_TOKENS", "lots");

    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI_MONTHLY_TOKENS"));
    warn.mockRestore();
  });
});

describe("budgetOf", () => {
  it("gives a trial 3M tokens for the whole trial, with a daily ceiling of a fifth, however many members it has", async () => {
    m.entitlements = { plan: "pro", trial: true, expiresAt: new Date("2026-11-08T23:59:59Z") };

    expect(await budgetOf(db)).toEqual({ scope: "trial", limit: 3_000_000, dailyCeiling: 600_000 });
    m.active = 14;
    expect(await budgetOf(db)).toEqual({ scope: "trial", limit: 3_000_000, dailyCeiling: 600_000 });
  });

  it("counts the members who are in, not the ones who have only been invited", async () => {
    m.active = 10;
    m.pending = 5;

    expect(await budgetOf(db)).toMatchObject({ limit: 15_000_000 });
  });

  it("rounds the daily ceiling up, and never to nothing", async () => {
    m.hosted = false;
    vi.stubEnv("AI_DAILY_PERCENT", "20");
    vi.stubEnv("AI_MONTHLY_TOKENS", "1000001");
    expect(await budgetOf(db)).toMatchObject({ dailyCeiling: 200_001 });

    vi.stubEnv("AI_MONTHLY_TOKENS", "3");
    expect(await budgetOf(db)).toMatchObject({ limit: 3, dailyCeiling: 1 });
  });

  it("gives Pro 15M a month, and 1M more for every member above the ten it includes", async () => {
    expect(await budgetOf(db)).toMatchObject({ scope: "month", limit: 15_000_000, dailyCeiling: 3_000_000 });
    m.active = 8;
    expect(await budgetOf(db)).toMatchObject({ limit: 15_000_000 });
    m.active = 14;
    expect(await budgetOf(db)).toMatchObject({ limit: 19_000_000, dailyCeiling: 3_800_000 });
  });

  it("has no limit on a self-hosted instance that set none, and the one it set where it did", async () => {
    m.hosted = false;
    expect(await budgetOf(db)).toBeNull();

    vi.stubEnv("AI_MONTHLY_TOKENS", "1000000");
    expect(await budgetOf(db)).toMatchObject({ scope: "month", limit: 1_000_000, dailyCeiling: 0 });
    vi.stubEnv("AI_DAILY_PERCENT", "10");
    expect(await budgetOf(db)).toMatchObject({ dailyCeiling: 100_000 });
  });

  it("has no limit where it is switched off, and no daily ceiling where that is", async () => {
    vi.stubEnv("AI_MONTHLY_TOKENS", "0");
    expect(await budgetOf(db)).toBeNull();

    vi.stubEnv("AI_MONTHLY_TOKENS", "10000000");
    vi.stubEnv("AI_DAILY_PERCENT", "0");
    expect(await budgetOf(db)).toMatchObject({ limit: 10_000_000, dailyCeiling: 0 });
    vi.stubEnv("AI_DAILY_PERCENT", "250");
    expect(await budgetOf(db)).toMatchObject({ dailyCeiling: 10_000_000 });
  });
});

describe("aiLimitWarnings", () => {
  it("says a cap that is no longer read is not, once for each that is set", () => {
    expect(aiLimitWarnings({ PM_DAILY_TURN_CAP: "100", AI_DAILY_GENERATION_CAP: "200", PM_DAILY_TOKEN_CAP: " " }, true)).toEqual([
      expect.stringContaining("PM_DAILY_TURN_CAP is no longer read"),
      expect.stringContaining("AI_DAILY_GENERATION_CAP is no longer read"),
    ]);
  });

  it("says nothing bounds the key on a self-hosted instance that has one and no limit", () => {
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x" }, false)).toEqual([expect.stringContaining("nothing limits what AI may spend")]);
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x", AI_MONTHLY_TOKENS: "lots" }, false)).toEqual([
      expect.stringContaining("nothing limits what AI may spend"),
    ]);
    // A daily share or a per-member amount scales an allowance that is not there
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x", AI_DAILY_PERCENT: "20", AI_MEMBER_TOKENS: "1000000" }, false)).toEqual([
      expect.stringContaining("nothing limits what AI may spend"),
    ]);
  });

  it("stays quiet where a limit is set, even one set to off, where the key is the organisation's own business, and where nothing is configured", () => {
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x", AI_MONTHLY_TOKENS: "5000000" }, false)).toEqual([]);
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x", AI_MONTHLY_TOKENS: "0" }, false)).toEqual([]);
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x", AI_TRIAL_TOKENS: "3000000" }, false)).toEqual([]);
    expect(aiLimitWarnings({ OPENROUTER_API_KEY: "sk-or-x" }, true)).toEqual([]);
    expect(aiLimitWarnings({}, false)).toEqual([]);
  });
});

// BP-678: the operator's own figure for one organisation
describe("budgetOf with the operator's allowance", () => {
  it("replaces the monthly figure, the members' share with it, and the daily ceiling follows it", async () => {
    m.active = 14;
    m.allowance = { tokens: 2_000_000, scope: "month" };

    expect(await budgetOf(db)).toEqual({ scope: "month", limit: 2_000_000, dailyCeiling: 400_000 });
  });

  it("replaces a trial's figure when it was set for the trial, and a trial stays counted as a trial", async () => {
    m.entitlements = { plan: "pro", trial: true };
    m.allowance = { tokens: 10_000, scope: "trial" };

    expect(await budgetOf(db)).toEqual({ scope: "trial", limit: 10_000, dailyCeiling: 2_000 });
  });

  it("is no limit at all when the operator lifted it, even where the environment sets one", async () => {
    vi.stubEnv("AI_MONTHLY_TOKENS", "1000");
    m.allowance = { tokens: null, scope: "month" };

    expect(await budgetOf(db)).toBeNull();
  });

  it("means nothing once the organisation is on the other counter: a trial's figure does not become a month's", async () => {
    m.allowance = { tokens: 1_000_000, scope: "trial" };
    expect(await budgetOf(db)).toMatchObject({ scope: "month", limit: 15_000_000 });

    m.entitlements = { plan: "pro", trial: true };
    m.allowance = { tokens: 1_000_000, scope: "month" };
    expect(await budgetOf(db)).toMatchObject({ scope: "trial", limit: 3_000_000 });

    m.allowance = { tokens: null, scope: "month" };
    expect(await budgetOf(db)).toMatchObject({ scope: "trial", limit: 3_000_000 });
  });

  it("gives the plan's figure back when there is none, whether it was never set or cleared", async () => {
    for (const none of [undefined, null]) {
      m.allowance = none;
      expect(await budgetOf(db)).toMatchObject({ scope: "month", limit: 15_000_000 });
    }
  });

  it("never lets a figure that is not a whole number of 1 or more, as a hand edit could leave one, open the limit", async () => {
    for (const tokens of [0, -1, NaN, Infinity, 1.5, "5", undefined]) {
      m.allowance = { tokens, scope: "month" };
      expect(await budgetOf(db), String(tokens)).toMatchObject({ scope: "month", limit: 15_000_000 });
    }
    m.allowance = "lots";
    expect(await budgetOf(db)).toMatchObject({ limit: 15_000_000 });
  });
});
