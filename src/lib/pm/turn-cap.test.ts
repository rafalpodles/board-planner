import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { countDocuments, resolveDailyTurnCap } = vi.hoisted(() => ({
  countDocuments: vi.fn(async (_filter?: unknown): Promise<number> => 0),
  resolveDailyTurnCap: vi.fn(async (v?: number): Promise<number> => v || 100),
}));
vi.mock("@/models/pmMessage", () => ({ PmMessage: { countDocuments } }));
vi.mock("./availability", () => ({ resolveDailyTurnCap }));

import { isOverDailyTurnCap } from "./turn-cap";

/**
 * BP-453. The cap counted from the server's midnight. Railway runs UTC, so a Warsaw board's
 * allowance turned over at 02:00 local in summer and a 23:00 session was spending tomorrow's.
 */
describe("the day the daily turn cap is counted in", () => {
  // 09:00 UTC on the 30th. It is already the 30th in Kiritimati (UTC+14) and still the 29th in
  // Niue (UTC-11), so the two zones disagree about which day this is.
  const NOW = new Date("2026-08-30T09:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    countDocuments.mockResolvedValue(0);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  const since = () =>
    (countDocuments.mock.calls[0][0] as { createdAt: { $gte: Date } }).createdAt.$gte.toISOString();

  /**
   * Two zones 25 hours apart, asserted in the same run. No server timezone can agree with both, so
   * neither expectation can be satisfied by a `setHours(0,0,0,0)` that happens to match the host —
   * which is what made the old code look right on a developer's laptop in Warsaw.
   */
  it("is the project's, not the host's — proved by two zones no host can both be", async () => {
    await isOverDailyTurnCap("p1", { autonomy: { timezone: "Pacific/Kiritimati" } });
    expect(since()).toBe("2026-08-29T10:00:00.000Z");

    countDocuments.mockClear();
    await isOverDailyTurnCap("p1", { autonomy: { timezone: "Pacific/Niue" } });
    expect(since()).toBe("2026-08-29T11:00:00.000Z");
  });

  it("uses Warsaw when the board never named a zone", async () => {
    await isOverDailyTurnCap("p1", {});
    expect(since()).toBe("2026-08-29T22:00:00.000Z");
  });

  it("uses Warsaw when the stored zone is one this server cannot read", async () => {
    await isOverDailyTurnCap("p1", { autonomy: { timezone: "Warsaw" } });
    expect(since()).toBe("2026-08-29T22:00:00.000Z");
  });

  /**
   * The gesture the ticket is about. It is 23:30 on the 30th in Warsaw; the board's day began at
   * 22:00Z on the 29th, and the host's began two hours later. Those two hours are Warsaw's
   * 00:00–02:00 — turns the reader spent this morning, which the old boundary had already
   * forgotten while they were still having the same day.
   */
  it("counts the first two hours of the board's day, which the host's boundary drops", async () => {
    vi.setSystemTime(new Date("2026-08-30T21:30:00Z"));

    await isOverDailyTurnCap("p1", { autonomy: { timezone: "Europe/Warsaw" } });
    expect(since()).toBe("2026-08-29T22:00:00.000Z");

    // The contrast, in the same test so neither number can quietly become the other: a UTC board
    // at this same instant counts from a boundary two hours later.
    countDocuments.mockClear();
    await isOverDailyTurnCap("p1", { autonomy: { timezone: "UTC" } });
    expect(since()).toBe("2026-08-30T00:00:00.000Z");
  });

  // The controls: the boundary is only half the answer, and a cap that never fires or always
  // fires would satisfy every assertion above.
  it("compares the count against the cap, both ways", async () => {
    countDocuments.mockResolvedValue(99);
    expect(await isOverDailyTurnCap("p1", { dailyTurnCap: 100 })).toMatchObject({
      over: false,
      cap: 100,
      used: 99,
    });

    countDocuments.mockResolvedValue(100);
    expect(await isOverDailyTurnCap("p1", { dailyTurnCap: 100 })).toMatchObject({
      over: true,
      cap: 100,
      used: 100,
    });
  });

  it("counts only this project's user messages", async () => {
    await isOverDailyTurnCap("p7", {});
    expect(countDocuments.mock.calls[0][0]).toMatchObject({ project: "p7", role: "user" });
  });
});
