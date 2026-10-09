import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  hosted: true,
  entitlements: { plan: "pro", trial: false, expiresAt: undefined as Date | undefined } as Record<string, unknown>,
  active: 10,
}));

vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({ entitlements: m.entitlements }) }));
vi.mock("@/lib/member-limit", () => ({ memberCounts: async () => ({ active: m.active, pending: 0 }) }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => (m.hosted ? "board-planner.com" : null) }));

const { budgetOf, limitFromEnv } = await import("./limits");

const db = { organisation: "org" } as never;

beforeEach(() => {
  m.hosted = true;
  m.entitlements = { plan: "pro", trial: false };
  m.active = 10;
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

  it("says so and falls back to the default for a value that is not a number", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_MONTHLY_TOKENS", "lots");

    expect(limitFromEnv("AI_MONTHLY_TOKENS")).toBe(15_000_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AI_MONTHLY_TOKENS"));
    warn.mockRestore();
  });
});

describe("budgetOf", () => {
  it("gives a trial 3M tokens for the whole trial, with a daily ceiling of a fifth, and ends with the trial", async () => {
    const endsAt = new Date("2026-11-08T23:59:59Z");
    m.entitlements = { plan: "pro", trial: true, expiresAt: endsAt };

    expect(await budgetOf(db)).toEqual({ scope: "trial", limit: 3_000_000, dailyCeiling: 600_000, endsAt });
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
