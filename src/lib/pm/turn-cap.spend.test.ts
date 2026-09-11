import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregate = vi.fn();
vi.mock("@/models/pmMessage", () => ({ PmMessage: { aggregate, countDocuments: vi.fn() } }));
const resolveDailyTokenCap = vi.fn();
vi.mock("./availability", () => ({ resolveDailyTokenCap, resolveDailyTurnCap: vi.fn() }));

const { dailyPmSpend } = await import("./turn-cap");

const PROJECT = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([
    {
      tokens: 120_000,
      // Summed but never reported: the premise "a cache read is part of the prompt count" is
      // checked against this, not against the day's total
      promptTokens: 100_000,
      cachedTokens: 90_000,
      cacheWriteTokens: 4_000,
      calls: 340,
      stepLimitHits: 2,
    },
  ]);
  resolveDailyTokenCap.mockResolvedValue(0);
});

/**
 * BP-284. `dailyTurnCap` counts turns, and a turn is up to MAX_STEPS round-trips — so the cap
 * permits a fifteen-fold range of spend and says nothing about where in it a project sits. This is
 * the measurement that makes the difference legible, and the ceiling expressed in what is billed.
 */
describe("dailyPmSpend", () => {
  it("reports what the day cost, calls beside tokens", async () => {
    const spend = await dailyPmSpend(PROJECT, {});

    expect(spend.tokens).toBe(120_000);
    // The number the turn cap was mistaken for — reported so the two can be compared
    expect(spend.calls).toBe(340);
    expect(spend.stepLimitHits).toBe(2);
  });

  /**
   * The control this whole change is shaped around. The ceiling defaults to off, so shipping it
   * must refuse nothing that works today — a cap of 0 that read as "0 tokens allowed" would stop
   * every PM on every instance the moment this merged.
   */
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

  // A day with no turns aggregates to nothing at all, which must read as zero rather than as NaN
  it("reads an empty day as zero", async () => {
    aggregate.mockResolvedValue([]);

    const spend = await dailyPmSpend(PROJECT, {});

    expect(spend).toMatchObject({
      tokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
      stepLimitHits: 0,
      over: false,
    });
  });

  /**
   * BP-568. What share of the day was served from cache, reported apart from the total it is
   * already inside. The aggregate is mocked here, so this says the figures are carried and not
   * what the pipeline computes — `pm-what-a-turn-costs.spec.ts` drives that against real Mongo,
   * which is also the only place the schema's field name and the pipeline's path are compared.
   */
  it("carries the cache figures out beside the tokens they are part of", async () => {
    const spend = await dailyPmSpend(PROJECT, {});

    expect(spend.cachedTokens).toBe(90_000);
    expect(spend.cacheWriteTokens).toBe(4_000);
    // The denominator the settings screen needs, and the number the premise check uses
    expect(spend.promptTokens).toBe(100_000);
    // Not added to it: the ceiling is judged on the same total as before
    expect(spend.tokens).toBe(120_000);
  });

  /**
   * The subset premise is the provider's, and a provider that counted cache reads outside its
   * prompt total would make the day's spend understate what was billed while the settings screen
   * still rendered a plausible share. Nothing on screen could show that, so it goes to the log.
   */
  it("says so in the log when a provider reports more cached than spent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    aggregate.mockResolvedValue([
      { tokens: 1_000, promptTokens: 800, cachedTokens: 4_000, cacheWriteTokens: 0, calls: 1, stepLimitHits: 0 },
    ]);

    await dailyPmSpend(PROJECT, {});

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("understated"));
    warn.mockRestore();
  });

  /**
   * The case that decides which number the premise is about. 600k cached against 400k prompt is a
   * broken premise by 200k — but the day's total is 700k, so a comparison against *that* sees
   * 600k < 700k and says nothing. The understatement is real and silent (BP-568 review).
   */
  it("catches a broken premise that hides under the completion tokens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    aggregate.mockResolvedValue([
      { tokens: 700_000, promptTokens: 400_000, cachedTokens: 600_000, cacheWriteTokens: 0, calls: 9, stepLimitHits: 0 },
    ]);

    await dailyPmSpend(PROJECT, {});

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400000 prompt"));
    warn.mockRestore();
  });

  // The control: the ordinary case is silent, so the warning means something when it appears
  it("says nothing when the cached share is a share", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dailyPmSpend(PROJECT, {});

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A cached token is a token already counted, so a cheap day must not read as an over-spent one
  it("judges the ceiling on the total, not on the total plus its cached share", async () => {
    resolveDailyTokenCap.mockResolvedValue(150_000);

    expect((await dailyPmSpend(PROJECT, { dailyTokenCap: 150_000 })).over).toBe(false);
  });

  // The project's day, the same one the turn cap already uses — a UTC server would otherwise turn
  // a Warsaw board's allowance over at 02:00 local
  it("asks only for today, in the project's own timezone", async () => {
    await dailyPmSpend(PROJECT, { autonomy: { timezone: "Europe/Warsaw" } });

    const match = aggregate.mock.calls[0][0][0].$match;
    expect(match.createdAt.$gte).toBeInstanceOf(Date);
    expect(String(match.project)).toBe(PROJECT);
  });
});
