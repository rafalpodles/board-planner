import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { countDocuments, resolveDailyTurnCap } = vi.hoisted(() => ({
  countDocuments: vi.fn(async (_filter?: unknown): Promise<number> => 0),
  resolveDailyTurnCap: vi.fn(async (v?: number): Promise<number> => v || 100),
}));
vi.mock("@/models/pmMessage", () => ({ PmMessage: { countDocuments } }));
vi.mock("./availability", () => ({ resolveDailyTurnCap }));

import { isOverDailyTurnCap } from "./turn-cap";

describe("the day the daily turn cap is counted in", () => {
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

  it("counts the first two hours of the board's day, which the host's boundary drops", async () => {
    vi.setSystemTime(new Date("2026-08-30T21:30:00Z"));

    await isOverDailyTurnCap("p1", { autonomy: { timezone: "Europe/Warsaw" } });
    expect(since()).toBe("2026-08-29T22:00:00.000Z");

    countDocuments.mockClear();
    await isOverDailyTurnCap("p1", { autonomy: { timezone: "UTC" } });
    expect(since()).toBe("2026-08-30T00:00:00.000Z");
  });

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
