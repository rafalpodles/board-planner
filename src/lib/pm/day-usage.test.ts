import { describe, it, expect, vi, beforeEach } from "vitest";

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
});
