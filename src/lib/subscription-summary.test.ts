import { describe, it, expect } from "vitest";
import { moneyOf, subscriptionSummary } from "./subscription-summary";

// BP-676
describe("subscriptionSummary", () => {
  it("keeps the six fields the page shows and drops everything else the service sends", () => {
    expect(
      subscriptionSummary({ status: "active", interval: "year", launch: true, extraMembers: 3, currentPeriodEnd: "2026-11-08T21:00:00.000Z", cancelAtPeriodEnd: true, stripeCustomerId: "cus_secret", anything: 1 })
    ).toEqual({ status: "active", interval: "year", launch: true, extraMembers: 3, currentPeriodEnd: "2026-11-08T21:00:00.000Z", cancelAtPeriodEnd: true });
  });

  it("is null for no subscription, and reads what is wrongly typed as nothing", () => {
    expect(subscriptionSummary(null)).toBeNull();
    expect(subscriptionSummary("active")).toBeNull();
    expect(subscriptionSummary({ status: 5, interval: "week", launch: "yes", extraMembers: "3", currentPeriodEnd: 9, cancelAtPeriodEnd: 1 })).toEqual({
      status: null,
      interval: null,
      launch: false,
      extraMembers: 0,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
  });
});

// BP-949
describe("moneyOf", () => {
  it("reads an amount in the smallest unit and its currency from the field the service uses", () => {
    expect(moneyOf({ unitAmount: 300, currency: "USD", other: 1 }, "unitAmount")).toEqual({ amount: 300, currency: "usd" });
    expect(moneyOf({ amountDue: 5400, currency: "eur" }, "amountDue")).toEqual({ amount: 5400, currency: "eur" });
  });

  it.each([["nothing", null], ["the other field", { amountDue: 5400, currency: "usd" }], ["a string amount", { unitAmount: "300", currency: "usd" }], ["a currency that is not a code", { unitAmount: 300, currency: "dollars" }], ["no currency", { unitAmount: 300 }]])("reads %s as no amount", (_why, value) => {
    expect(moneyOf(value, "unitAmount")).toBeNull();
  });
});
