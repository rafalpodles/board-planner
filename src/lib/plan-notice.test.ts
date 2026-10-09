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

  it("a trial past its end is Free at once, with no grace to show", () => {
    expect(planNotice({ plan: "pro", planEndsAt: day(-0.001), trial: true }, NOW)).toEqual({ kind: "free" });
    expect(planNotice({ plan: "pro", planEndsAt: day(-3), trial: true }, NOW)).toEqual({ kind: "free" });
    expect(planNotice({ plan: "pro", planEndsAt: day(5), trial: true }, NOW)).toMatchObject({ kind: "ending", daysLeft: 5 });
  });

  it("a Pro licence past its end is in grace for 14 days", () => {
    const ended = day(-3);
    expect(planNotice({ plan: "pro", planEndsAt: ended }, NOW)).toEqual({ kind: "grace", endedAt: ended, graceEndsAt: day(11), paymentFailed: false });
  });

  // BP-983: a subscription says whether it renews by itself or was cancelled
  describe("a subscription", () => {
    it("that renews by itself has nothing to warn about, however near its end", () => {
      expect(planNotice({ plan: "pro", planEndsAt: day(12), subscription: "renewing" }, NOW)).toEqual({ kind: "pro" });
      expect(planNotice({ plan: "pro", planEndsAt: day(0.1), subscription: "renewing" }, NOW)).toEqual({ kind: "pro" });
      expect(planNotice({ plan: "pro", planEndsAt: day(12) }, NOW)).toMatchObject({ kind: "ending", cancelled: false });
    });

    it("that renewed does not run past its end: a payment failed, and the 14 days are said as such", () => {
      const ended = day(-3);
      expect(planNotice({ plan: "pro", planEndsAt: ended, subscription: "renewing" }, NOW)).toEqual({ kind: "grace", endedAt: ended, graceEndsAt: day(11), paymentFailed: true });
      expect(planNotice({ plan: "pro", planEndsAt: ended }, NOW)).toEqual({ kind: "grace", endedAt: ended, graceEndsAt: day(11), paymentFailed: false });
    });

    it("that was cancelled says when it ends from the day it is cancelled, not in the last month, and is Free the moment it does", () => {
      expect(planNotice({ plan: "pro", planEndsAt: day(90), subscription: "ending" }, NOW)).toEqual({ kind: "ending", endsAt: day(90), daysLeft: 90, cancelled: true });
      expect(planNotice({ plan: "pro", planEndsAt: day(-0.001), subscription: "ending" }, NOW)).toEqual({ kind: "free" });
      expect(planNotice({ plan: "pro", planEndsAt: day(-3), subscription: "ending" }, NOW)).toEqual({ kind: "free" });
    });

    it("that has just run out is a renewal on its way for a day, and a payment that failed after that", () => {
      const at = (ago: number) => planNotice({ plan: "pro", planEndsAt: day(-ago), subscription: "renewing" }, NOW);

      expect(at(30 / 1440)).toEqual({ kind: "pro" });
      expect(at(0.99)).toEqual({ kind: "pro" });
      expect(at(1.01)).toMatchObject({ kind: "grace", paymentFailed: true });
      // Only a subscription that renews gets the day: an operator's key is in grace the moment it ends
      expect(planNotice({ plan: "pro", planEndsAt: day(-30 / 1440) }, NOW)).toMatchObject({ kind: "grace", paymentFailed: false });
    });

    it("is Free once its grace is over, as the server has it, whoever issued the key", () => {
      expect(planNotice({ plan: "pro", planEndsAt: day(-14.01), subscription: "renewing" }, NOW)).toEqual({ kind: "free" });
      expect(planNotice({ plan: "pro", planEndsAt: day(-14.01) }, NOW)).toEqual({ kind: "free" });
      expect(planNotice({ plan: "pro", planEndsAt: day(-13.9), subscription: "renewing" }, NOW)).toMatchObject({ kind: "grace" });
    });

    it("leaves a trial as it was, whatever else is passed", () => {
      expect(planNotice({ plan: "pro", planEndsAt: day(5), trial: true, subscription: null }, NOW)).toMatchObject({ kind: "ending", daysLeft: 5, cancelled: false });
    });
  });
});
