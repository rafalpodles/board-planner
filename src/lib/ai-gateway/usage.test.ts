// A server that is not on UTC is where a day read in local time goes wrong; the runner of the suite may well be on it
process.env.TZ = "Pacific/Auckland";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordUsage } from "./usage";

const create = vi.fn();
const updateOne = vi.fn();
const db = { AiUsage: { create }, AiBudget: { updateOne } } as never;
const NOW = new Date("2026-10-09T10:00:00Z");
const USAGE = { promptTokens: 900, completionTokens: 100, totalTokens: 1000, cachedPromptTokens: 400, cacheWriteTokens: 0 };

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
  updateOne.mockReset().mockResolvedValue({});
});

// BP-679: one row per call, and what it cost added to the organisation's counters
describe("recordUsage", () => {
  it("writes a row for the call with what the provider reported, and adds its tokens to today's counter and the month's", async () => {
    await recordUsage(db, { source: "pm", keySource: "managed", projectId: "p1", userId: "u1", model: "m/x", usage: USAGE }, "month", NOW);

    expect(create).toHaveBeenCalledWith({
      project: "p1",
      user: "u1",
      source: "pm",
      keySource: "managed",
      model: "m/x",
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000,
      cachedPromptTokens: 400,
      cacheWriteTokens: 0,
    });
    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2026-10-09" }, { $inc: { tokens: 1000, calls: 1 } }, { upsert: true });
    expect(updateOne).toHaveBeenCalledWith({ kind: "month", period: "2026-10" }, { $inc: { tokens: 1000, calls: 1 } }, { upsert: true });
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it("adds a trial's tokens to the counter that is the trial's, which is not a month", async () => {
    await recordUsage(db, { source: "assist", keySource: "managed", model: "m/x", usage: USAGE }, "trial", NOW);

    expect(updateOne).toHaveBeenCalledWith({ kind: "trial", period: "all" }, { $inc: { tokens: 1000, calls: 1 } }, { upsert: true });
  });

  it("counts the organisation's own key apart, which no limit is made of", async () => {
    await recordUsage(db, { source: "pm", keySource: "own", model: "m/x", usage: USAGE }, "month", NOW);

    expect(updateOne).toHaveBeenCalledWith({ kind: "month", period: "2026-10" }, { $inc: { ownTokens: 1000, ownCalls: 1 } }, { upsert: true });
  });

  it("counts a call whose size the provider did not report as a call of no tokens, not as nothing", async () => {
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x" }, "month", NOW);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 0, promptTokens: 0 }));
    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2026-10-09" }, { $inc: { tokens: 0, calls: 1 } }, { upsert: true });
  });

  it("adds again when two first calls of a period created the same counter at once, and lets any other failure through", async () => {
    updateOne.mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: USAGE }, "month", NOW);
    expect(updateOne).toHaveBeenCalledTimes(3);

    updateOne.mockReset().mockRejectedValue(new Error("connection lost"));
    await expect(recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: USAGE }, "month", NOW)).rejects.toThrow("connection lost");
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it("adds the tokens to the counters even when the row that logs the call cannot be written, since the limits are made of the counters", async () => {
    create.mockRejectedValue(new Error("db full"));

    await expect(recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: USAGE }, "month", NOW)).rejects.toThrow("db full");

    expect(updateOne).toHaveBeenCalledWith({ kind: "month", period: "2026-10" }, { $inc: { tokens: 1000, calls: 1 } }, { upsert: true });
  });

  it("never takes tokens off a counter, whatever a provider reports", async () => {
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: { ...USAGE, totalTokens: -500 } }, "month", NOW);

    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2026-10-09" }, { $inc: { tokens: 0, calls: 1 } }, { upsert: true });
  });

  it("adds nothing, rather than not-a-number, for a total that is not a number: a counter that is NaN is never over its limit", async () => {
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: { ...USAGE, totalTokens: NaN } }, "month", NOW);

    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2026-10-09" }, { $inc: { tokens: 0, calls: 1 } }, { upsert: true });
  });

  it("names the day and the month in UTC, not where the server is, at the edges of both", async () => {
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: USAGE }, "month", new Date("2026-12-31T23:30:00Z"));
    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2026-12-31" }, expect.anything(), { upsert: true });
    expect(updateOne).toHaveBeenCalledWith({ kind: "month", period: "2026-12" }, expect.anything(), { upsert: true });

    updateOne.mockClear();
    await recordUsage(db, { source: "pm", keySource: "managed", model: "m/x", usage: USAGE }, "month", new Date("2027-01-01T00:30:00Z"));
    expect(updateOne).toHaveBeenCalledWith({ kind: "day", period: "2027-01-01" }, expect.anything(), { upsert: true });
    expect(updateOne).toHaveBeenCalledWith({ kind: "month", period: "2027-01" }, expect.anything(), { upsert: true });
  });
});
