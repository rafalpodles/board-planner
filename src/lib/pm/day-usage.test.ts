import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const usageAggregate = vi.fn();
const messageAggregate = vi.fn();
const countDocuments = vi.fn();
vi.mock("@/models/aiUsage", () => ({ AiUsage: { aggregate: usageAggregate } }));
vi.mock("@/models/pmMessage", () => ({ PmMessage: { aggregate: messageAggregate, countDocuments } }));

const { pmDayUsage } = await import("./day-usage");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("@/lib/organisation-field");
const db = scopedToDefaultOrganisation();

const PROJECT = "507f1f77bcf86cd799439011";

beforeEach(() => {
  vi.clearAllMocks();
  usageAggregate.mockResolvedValue([{ tokens: 120_000, promptTokens: 100_000, cachedTokens: 90_000, cacheWriteTokens: 4_000, calls: 340 }]);
  messageAggregate.mockResolvedValue([{ hits: 2 }]);
  countDocuments.mockResolvedValue(25);
});

// BP-682: what the PM used today is read from the gateway's usage rows, the rows the organisation's allowance is made of
describe("pmDayUsage", () => {
  it("reports the day's tokens and calls from the usage rows, and its turns beside them", async () => {
    expect(await pmDayUsage(db, PROJECT, {})).toEqual({
      turns: 25,
      calls: 340,
      tokens: 120_000,
      promptTokens: 100_000,
      cachedTokens: 90_000,
      cacheWriteTokens: 4_000,
      stepLimitHits: 2,
    });
  });

  it("asks the usage rows for this project's PM calls since the project's midnight, and for nobody else's", async () => {
    await pmDayUsage(db, PROJECT, { autonomy: { timezone: "Europe/Warsaw" } });

    const [wall, match] = usageAggregate.mock.calls[0][0];
    expect(wall).toEqual({ $match: { organisation: DEFAULT_ORGANISATION_ID } });
    expect(String(match.$match.project)).toBe(PROJECT);
    expect(match.$match.source).toBe("pm");
    expect(match.$match.createdAt.$gte).toBeInstanceOf(Date);
  });

  it("counts a turn as a message from a person since the project's midnight", async () => {
    await pmDayUsage(db, PROJECT, {});

    expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({ project: PROJECT, role: "user", createdAt: { $gte: expect.any(Date) } }));
  });

  it("reads an empty day as zero rather than as nothing", async () => {
    usageAggregate.mockResolvedValue([]);
    messageAggregate.mockResolvedValue([]);
    countDocuments.mockResolvedValue(0);

    expect(await pmDayUsage(db, PROJECT, {})).toEqual({ turns: 0, calls: 0, tokens: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, stepLimitHits: 0 });
  });

  it("says so in the log when a provider reports more cached than spent, which understates what was billed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    usageAggregate.mockResolvedValue([{ tokens: 700_000, promptTokens: 400_000, cachedTokens: 600_000, cacheWriteTokens: 0, calls: 9 }]);

    await pmDayUsage(db, PROJECT, {});

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400000 prompt"));
    warn.mockRestore();
  });

  it("says nothing when the cached share is a share", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pmDayUsage(db, PROJECT, {});

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("asks the thread for the turns that ran out of steps, of this project (an ObjectId, which an aggregate does not cast) and today", async () => {
    await pmDayUsage(db, PROJECT, {});

    const { $match } = messageAggregate.mock.calls[0][0][1];
    expect($match["usage.hitStepLimit"]).toBe(true);
    expect($match.project.constructor.name).toBe("ObjectId");
    expect(String($match.project)).toBe(PROJECT);
    expect($match.createdAt.$gte).toBeInstanceOf(Date);
  });

  describe("the project's day", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());

    const sinceInEveryQuery = async (pm: { autonomy?: { timezone?: string } }) => {
      usageAggregate.mockClear();
      messageAggregate.mockClear();
      countDocuments.mockClear();
      await pmDayUsage(db, PROJECT, pm);
      const starts = [
        usageAggregate.mock.calls[0][0][1].$match.createdAt.$gte,
        messageAggregate.mock.calls[0][0][1].$match.createdAt.$gte,
        countDocuments.mock.calls[0][0].createdAt.$gte,
      ] as Date[];
      expect(new Set(starts.map((d) => d.toISOString())).size).toBe(1);
      return starts[0].toISOString();
    };

    it("starts at midnight in the board's own zone, in all three queries, not at the server's", async () => {
      vi.setSystemTime(new Date("2026-10-09T22:30:00Z"));

      // 00:30 on the 10th in Warsaw, 11:30 on the 9th in Niue
      expect(await sinceInEveryQuery({ autonomy: { timezone: "Europe/Warsaw" } })).toBe("2026-10-09T22:00:00.000Z");
      expect(await sinceInEveryQuery({ autonomy: { timezone: "Pacific/Niue" } })).toBe("2026-10-09T11:00:00.000Z");
    });

    it("counts in Europe/Warsaw when the board never named a zone, or named one the server cannot read", async () => {
      vi.setSystemTime(new Date("2026-10-09T22:30:00Z"));

      expect(await sinceInEveryQuery({})).toBe("2026-10-09T22:00:00.000Z");
      expect(await sinceInEveryQuery({ autonomy: { timezone: "Warsaw" } })).toBe("2026-10-09T22:00:00.000Z");
    });
  });
});
