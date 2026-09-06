import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregate = vi.fn();
vi.mock("@/models/pmMessage", () => ({ PmMessage: { aggregate, countDocuments: vi.fn() } }));
const resolveDailyTokenCap = vi.fn();
vi.mock("./availability", () => ({ resolveDailyTokenCap, resolveDailyTurnCap: vi.fn() }));

const { dailyPmSpend } = await import("./turn-cap");

const PROJECT = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([{ tokens: 120_000, calls: 340, stepLimitHits: 2 }]);
  resolveDailyTokenCap.mockResolvedValue(0);
});

describe("dailyPmSpend", () => {
  it("reports what the day cost, calls beside tokens", async () => {
    const spend = await dailyPmSpend(PROJECT, {});

    expect(spend.tokens).toBe(120_000);
    expect(spend.calls).toBe(340);
    expect(spend.stepLimitHits).toBe(2);
  });

  it("is never over when no ceiling is configured, however much was spent", async () => {
    aggregate.mockResolvedValue([{ tokens: 99_000_000, calls: 9_000, stepLimitHits: 500 }]);

    expect((await dailyPmSpend(PROJECT, {})).over).toBe(false);
  });

  it("is over once a configured ceiling is reached", async () => {
    resolveDailyTokenCap.mockResolvedValue(100_000);

    expect((await dailyPmSpend(PROJECT, { dailyTokenCap: 100_000 })).over).toBe(true);
  });

  it("is not over below it", async () => {
    resolveDailyTokenCap.mockResolvedValue(200_000);

    expect((await dailyPmSpend(PROJECT, { dailyTokenCap: 200_000 })).over).toBe(false);
  });

  it("reads an empty day as zero", async () => {
    aggregate.mockResolvedValue([]);

    const spend = await dailyPmSpend(PROJECT, {});

    expect(spend).toMatchObject({ tokens: 0, calls: 0, stepLimitHits: 0, over: false });
  });

  it("asks only for today, in the project's own timezone", async () => {
    await dailyPmSpend(PROJECT, { autonomy: { timezone: "Europe/Warsaw" } });

    const match = aggregate.mock.calls[0][0][0].$match;
    expect(match.createdAt.$gte).toBeInstanceOf(Date);
    expect(String(match.project)).toBe(PROJECT);
  });
});
