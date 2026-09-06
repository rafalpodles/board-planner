import { describe, it, expect } from "vitest";
import { clampCeiling, createBudget, DEFAULT_RUN_CEILING_MS, LEASE_MS } from "./budget.js";

describe("createBudget", () => {
  it("gives an entry the cap the caller asked for while there is room", () => {
    const budget = createBudget(90 * 60_000, () => 0);

    expect(budget.forEntry(30 * 60_000)).toBe(30 * 60_000);
    expect(budget.forEntry(10 * 60_000)).toBe(10 * 60_000);
  });

  it("gives the last entry only what is left, so the ceiling binds", () => {
    let now = 0;
    const budget = createBudget(12 * 60_000, () => now);
    now = 8 * 60_000;

    expect(budget.forEntry(10 * 60_000)).toBe(4 * 60_000);
  });

  it("never hands out a negative timeout", () => {
    let now = 0;
    const budget = createBudget(60_000, () => now);
    now = 120_000;

    expect(budget.forEntry(10_000)).toBe(0);
  });

  it("is exhausted once the ceiling passes", () => {
    let now = 0;
    const budget = createBudget(60_000, () => now);
    expect(budget.exhausted()).toBe(false);

    now = 61_000;
    expect(budget.exhausted()).toBe(true);
  });
});

describe("clampCeiling", () => {
  it("keeps a quarter hour under the lease, so the gap between the two clocks fits", () => {
    expect(clampCeiling(4 * 60 * 60_000)).toBe(LEASE_MS - 15 * 60_000);
  });

  it("keeps a sane one", () => {
    expect(clampCeiling(90 * 60_000)).toBe(90 * 60_000);
  });

  it("falls back to the default on nonsense", () => {
    expect(clampCeiling(0)).toBe(DEFAULT_RUN_CEILING_MS);
    expect(clampCeiling(Number.NaN)).toBe(DEFAULT_RUN_CEILING_MS);
    expect(clampCeiling(-1)).toBe(DEFAULT_RUN_CEILING_MS);
  });
});
