import { describe, it, expect } from "vitest";
import { describeReconciliation, providerModelName, reconcile, utcDayRange } from "./reconcile";

const ours = (over: object = {}) => ({ model: "moonshotai/kimi-k2.6", calls: 100, promptTokens: 1_000_000, completionTokens: 50_000, ...over });
const theirs = (over: object = {}) => ({ model: "moonshotai/kimi-k2.6", requests: 100, prompt_tokens: 1_000_000, completion_tokens: 50_000, ...over });

// BP-647: our counters are the operator's view of its spend, so they are checked against the provider's for a day
describe("reconcile", () => {
  it("agrees where the two say the same", () => {
    const result = reconcile([ours()], [theirs()], 0.02);

    expect(result.within).toBe(true);
    expect(result.models).toEqual([expect.objectContaining({ model: "moonshotai/kimi-k2.6", within: true, difference: { calls: 0, promptTokens: 0, completionTokens: 0 } })]);
  });

  it("allows a difference up to the tolerance in any of the three figures, and no more", () => {
    expect(reconcile([ours({ calls: 101 })], [theirs()], 0.02).within).toBe(true);
    expect(reconcile([ours({ calls: 103 })], [theirs()], 0.02).within).toBe(false);
    expect(reconcile([ours({ promptTokens: 1_030_000 })], [theirs()], 0.02).within).toBe(false);
    expect(reconcile([ours({ completionTokens: 48_000 })], [theirs()], 0.02).within).toBe(false);
    expect(reconcile([ours({ completionTokens: 49_500 })], [theirs()], 0.02).within).toBe(true);
  });

  it("reads a difference below as well as above: tokens we did not count are as wrong as tokens we invented", () => {
    const result = reconcile([ours({ promptTokens: 900_000 })], [theirs()], 0.02);

    expect(result.within).toBe(false);
    expect(result.models[0].difference.promptTokens).toBeCloseTo(-0.1);
  });

  it("sums the rows of one model on both sides, and ours across keys, before comparing", () => {
    const result = reconcile(
      [ours({ calls: 60, promptTokens: 600_000, completionTokens: 30_000 }), ours({ calls: 40, promptTokens: 400_000, completionTokens: 20_000 })],
      [theirs({ requests: 70, prompt_tokens: 700_000, completion_tokens: 35_000 }), theirs({ requests: 30, prompt_tokens: 300_000, completion_tokens: 15_000 })],
      0.01
    );

    expect(result.models).toHaveLength(1);
    expect(result.within).toBe(true);
  });

  it("names AI Assist's model as the provider does, so that its rows meet the provider's and are not a model of their own", () => {
    expect(providerModelName("gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(providerModelName("Moonshotai/Kimi-K2.6")).toBe("moonshotai/kimi-k2.6");

    const result = reconcile([ours({ model: "gpt-4o-mini" })], [theirs({ model: "openai/gpt-4o-mini" })], 0.02);

    expect(result.models.map((m) => m.model)).toEqual(["openai/gpt-4o-mini"]);
    expect(result.within).toBe(true);
  });

  it("flags a model that only one side has, which is a day's calls nobody accounts for", () => {
    const onlyTheirs = reconcile([], [theirs()], 0.02);
    expect(onlyTheirs.within).toBe(false);
    expect(onlyTheirs.models[0].difference.calls).toBe(-1);

    const onlyOurs = reconcile([ours()], [], 0.02);
    expect(onlyOurs.within).toBe(false);
    expect(onlyOurs.models[0].difference.calls).toBe(Infinity);
  });

  it("agrees where both are empty, which is a day without AI and not a failure", () => {
    expect(reconcile([], [], 0.02)).toEqual({ models: [], within: true });
  });

  it("lists the models in order, and keeps the provider's reasoning tokens beside the completion rather than adding them", () => {
    const result = reconcile([ours({ model: "z/model" }), ours({ model: "a/model" })], [theirs({ model: "a/model", reasoning_tokens: 7 }), theirs({ model: "z/model" })], 0.02);

    expect(result.models.map((m) => m.model)).toEqual(["a/model", "z/model"]);
    expect(result.models[0].theirs).toMatchObject({ completionTokens: 50_000, reasoningTokens: 7 });
  });
});

describe("describeReconciliation", () => {
  it("says which rows differ, by how much and on which figure, and what the verdict is", () => {
    const text = describeReconciliation("2026-10-09", reconcile([ours({ calls: 110 })], [theirs({ reasoning_tokens: 9 })], 0.02), 0.02);

    expect(text).toContain("AI usage on 2026-10-09 (UTC)");
    expect(text).toContain("DIFF moonshotai/kimi-k2.6");
    expect(text).toContain("calls       ours 110  theirs 100  +10.00%");
    expect(text).toContain("(the provider also reports 9 reasoning tokens)");
    expect(text).toContain("Does not agree within the tolerance");
  });

  it("says a model that only we have is only ours, and an empty day is not a failure", () => {
    expect(describeReconciliation("2026-10-09", reconcile([ours()], [], 0.02), 0.02)).toContain("only ours");
    expect(describeReconciliation("2026-10-09", reconcile([], [], 0.02), 0.02)).toContain("Agrees within the tolerance.");
  });
});

describe("utcDayRange", () => {
  const NOW = new Date("2026-10-10T08:00:00Z");

  it("takes yesterday and any completed day of the last 30, as a UTC day", () => {
    expect(utcDayRange("2026-10-09", NOW)).toEqual({ from: new Date("2026-10-09T00:00:00Z"), to: new Date("2026-10-10T00:00:00Z") });
    expect(utcDayRange("2026-09-10", NOW)).toMatchObject({ from: new Date("2026-09-10T00:00:00Z") });
  });

  it("refuses today and later, which the provider has not completed, and a day it no longer keeps", () => {
    expect(utcDayRange("2026-10-10", NOW)).toEqual({ error: expect.stringMatching(/completed UTC day/) });
    expect(utcDayRange("2026-10-11", NOW)).toEqual({ error: expect.stringMatching(/completed UTC day/) });
    expect(utcDayRange("2026-09-09", NOW)).toEqual({ error: expect.stringMatching(/last 30/) });
  });

  it("refuses what is not a day, including one that rolls over such as the 31st of a 30-day month", () => {
    expect(utcDayRange("yesterday", NOW)).toEqual({ error: "The day is YYYY-MM-DD" });
    expect(utcDayRange("2026-9-9", NOW)).toEqual({ error: "The day is YYYY-MM-DD" });
    expect(utcDayRange("2026-09-31", NOW)).toEqual({ error: "2026-09-31 is not a day" });
  });
});
