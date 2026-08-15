import { describe, it, expect } from "vitest";
import { clampCeiling, createBudget, DEFAULT_RUN_CEILING_MS, LEASE_MS } from "./budget.js";

describe("createBudget", () => {
  it("gives an entry the per-entry cap while there is room", () => {
    expect(createBudget(90 * 60_000, 10 * 60_000, () => 0).forEntry()).toBe(10 * 60_000);
  });

  it("gives the last entry only what is left, so the ceiling binds", () => {
    let now = 0;
    const budget = createBudget(12 * 60_000, 10 * 60_000, () => now);
    now = 8 * 60_000;

    expect(budget.forEntry()).toBe(4 * 60_000);
  });

  it("never hands out a negative timeout", () => {
    let now = 0;
    const budget = createBudget(60_000, 10_000, () => now);
    now = 120_000;

    expect(budget.forEntry()).toBe(0);
  });

  it("is exhausted once the ceiling passes", () => {
    let now = 0;
    const budget = createBudget(60_000, 10_000, () => now);
    expect(budget.exhausted()).toBe(false);

    now = 61_000;
    expect(budget.exhausted()).toBe(true);
  });
});

describe("clampCeiling", () => {
  // The same trust applyPolicy withholds over the rest of the policy: the worker recomputes
  it("refuses a ceiling that would outlive the lease, whatever the server said", () => {
    expect(clampCeiling(4 * 60 * 60_000)).toBeLessThan(LEASE_MS);
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
