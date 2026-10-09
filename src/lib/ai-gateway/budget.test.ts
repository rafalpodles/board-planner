// A server that is not on UTC is where a day read in local time goes wrong; the runner of the suite may well be on it
process.env.TZ = "Pacific/Auckland";

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ budget: null as unknown, rows: [] as { kind: string; period: string; tokens: number }[], trial: false }));

vi.mock("./limits", () => ({ budgetOf: async () => m.budget }));
vi.mock("@/lib/organisation", () => ({ getOrganisation: async () => ({ entitlements: { plan: "pro", trial: m.trial } }) }));

const { checkBudget, counterKindOf } = await import("./budget");

const NOW = new Date("2026-10-09T10:00:00Z");
const find = vi.fn();
const db = { organisation: "org", AiBudget: { find: (filter: unknown) => (find(filter), { lean: async () => m.rows }) } } as never;

beforeEach(() => {
  m.budget = { scope: "month", limit: 1000, dailyCeiling: 200 };
  m.rows = [];
  m.trial = false;
  find.mockClear();
});

// BP-680: a counter belongs to one organisation, so the one that is over is the only one refused
describe("checkBudget", () => {
  it("lets a call through while the allowance and today's ceiling are not reached, asking for the two counters of the period", async () => {
    m.rows = [{ kind: "month", period: "2026-10", tokens: 999 }, { kind: "day", period: "2026-10-09", tokens: 199 }];

    expect(await checkBudget(db, NOW)).toEqual({ refusal: null, counter: "month" });
    expect(find).toHaveBeenCalledWith({ $or: [{ kind: "day", period: "2026-10-09" }, { kind: "month", period: "2026-10" }] });
  });

  it("refuses at the month's allowance, which starts again on the first of the next month", async () => {
    m.rows = [{ kind: "month", period: "2026-10", tokens: 1000 }];

    expect((await checkBudget(db, NOW)).refusal).toEqual({ scope: "month", used: 1000, limit: 1000, resetsAt: new Date("2026-11-01T00:00:00Z") });
  });

  it("refuses at the day's ceiling, which starts again at midnight UTC, and the allowance is told before it", async () => {
    m.rows = [{ kind: "day", period: "2026-10-09", tokens: 200 }];
    expect((await checkBudget(db, NOW)).refusal).toEqual({ scope: "day", used: 200, limit: 200, resetsAt: new Date("2026-10-10T00:00:00Z") });

    m.rows = [{ kind: "day", period: "2026-10-09", tokens: 200 }, { kind: "month", period: "2026-10", tokens: 1000 }];
    expect((await checkBudget(db, NOW)).refusal?.scope).toBe("month");
  });

  it("refuses a trial at its allowance, which does not start again", async () => {
    m.budget = { scope: "trial", limit: 3_000_000, dailyCeiling: 600_000 };
    m.rows = [{ kind: "trial", period: "all", tokens: 3_000_000 }];

    expect(await checkBudget(db, NOW)).toEqual({ counter: "trial", refusal: { scope: "trial", used: 3_000_000, limit: 3_000_000, resetsAt: null } });
    expect(find).toHaveBeenCalledWith({ $or: [{ kind: "day", period: "2026-10-09" }, { kind: "trial", period: "all" }] });
  });

  it("reads the day in UTC: a call at 23:30 and one at 00:30 the next morning are on different days, and in different months at the year's end", async () => {
    await checkBudget(db, new Date("2026-12-31T23:30:00Z"));
    expect(find).toHaveBeenLastCalledWith({ $or: [{ kind: "day", period: "2026-12-31" }, { kind: "month", period: "2026-12" }] });

    m.rows = [{ kind: "month", period: "2026-12", tokens: 1000 }];
    expect((await checkBudget(db, new Date("2026-12-31T23:30:00Z"))).refusal?.resetsAt).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(find).toHaveBeenLastCalledWith({ $or: [{ kind: "day", period: "2026-12-31" }, { kind: "month", period: "2026-12" }] });

    await checkBudget(db, new Date("2027-01-01T00:30:00Z"));
    expect(find).toHaveBeenLastCalledWith({ $or: [{ kind: "day", period: "2027-01-01" }, { kind: "month", period: "2027-01" }] });
  });

  it("does not refuse for a day's ceiling that is off", async () => {
    m.budget = { scope: "month", limit: 1000, dailyCeiling: 0 };
    m.rows = [{ kind: "day", period: "2026-10-09", tokens: 999_999 }];

    expect((await checkBudget(db, NOW)).refusal).toBeNull();
  });

  it("asks nothing of the counters where there is no limit, and says which counter a call is added to", async () => {
    m.budget = null;
    m.trial = true;

    expect(await checkBudget(db, NOW)).toEqual({ refusal: null, counter: "trial" });
    expect(find).not.toHaveBeenCalled();
    m.trial = false;
    expect(await counterKindOf(db)).toBe("month");
  });
});
