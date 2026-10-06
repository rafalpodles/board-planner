import { describe, it, expect } from "vitest";
import { planNotice } from "./plan-notice";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000).toISOString();

describe("planNotice (BP-930)", () => {
  it("Free is Free whatever the stored date says", () => {
    expect(planNotice({ plan: "free", planEndsAt: day(5) }, NOW)).toEqual({ kind: "free" });
  });

  it("Pro with no end, or more than 30 days left, says nothing about time", () => {
    expect(planNotice({ plan: "pro", planEndsAt: null }, NOW)).toEqual({ kind: "pro" });
    expect(planNotice({ plan: "pro", planEndsAt: day(31) }, NOW)).toEqual({ kind: "pro" });
  });

  it("Pro with 30 days or fewer left counts the days, rounding up", () => {
    expect(planNotice({ plan: "pro", planEndsAt: day(30) }, NOW)).toMatchObject({ kind: "ending", daysLeft: 30 });
    expect(planNotice({ plan: "pro", planEndsAt: day(12.2) }, NOW)).toMatchObject({ kind: "ending", daysLeft: 13 });
    expect(planNotice({ plan: "pro", planEndsAt: day(0.1) }, NOW)).toMatchObject({ kind: "ending", daysLeft: 1 });
  });

  it("at the very instant it ends a licence is still valid, one millisecond later it is in grace", () => {
    const ends = new Date(NOW).toISOString();
    expect(planNotice({ plan: "pro", planEndsAt: ends }, NOW)).toMatchObject({ kind: "ending", daysLeft: 0 });
    expect(planNotice({ plan: "pro", planEndsAt: ends }, NOW + 1)).toMatchObject({ kind: "grace" });
  });

  it("a Pro licence past its end is in grace for 14 days", () => {
    const ended = day(-3);
    expect(planNotice({ plan: "pro", planEndsAt: ended }, NOW)).toEqual({ kind: "grace", endedAt: ended, graceEndsAt: day(11) });
  });
});
