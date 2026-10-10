import { describe, it, expect } from "vitest";
import { moneyOf, offerSummary, subscriptionSummary } from "./subscription-summary";

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

// BP-980
describe("offerSummary", () => {
  const usd = (unitAmount: number, currency = "usd") => ({ unitAmount, currency });
  const offer = (over: Record<string, unknown> = {}) => ({
    launch: true,
    includedMembers: 10,
    month: { base: usd(2900), member: usd(300) },
    year: { base: usd(29000), member: usd(3000) },
    ...over,
  });

  it("keeps the prices of both periods, what is included and whether it is the launch price, and drops the rest", () => {
    expect(offerSummary({ ...offer(), stripePriceId: "price_secret" })).toEqual({
      launch: true,
      includedMembers: 10,
      taxInclusive: false,
      month: { base: { amount: 2900, currency: "usd" }, member: { amount: 300, currency: "usd" } },
      year: { base: { amount: 29000, currency: "usd" }, member: { amount: 3000, currency: "usd" } },
    });
  });

  it("reads a launch flag that is not true as the standard price", () => {
    expect(offerSummary(offer({ launch: "yes" }))).toMatchObject({ launch: false });
  });

  it.each([
    ["nothing", null],
    ["a string", "$29"],
    ["no year", offer({ year: undefined })],
    ["a price with no amount", offer({ month: { base: usd(2900), member: { currency: "usd" } } })],
    ["a member price in another currency than its base", offer({ month: { base: usd(2900), member: usd(300, "eur") } })],
    ["a year in another currency than the month", offer({ year: { base: usd(29000, "eur"), member: usd(3000, "eur") } })],
    ["a negative price", offer({ month: { base: usd(-2900), member: usd(300) } })],
    ["a price that is not a whole number of cents", offer({ year: { base: usd(29000.5), member: usd(3000) } })],
    ["no members included", offer({ includedMembers: 0 })],
    ["a fraction of a member included", offer({ includedMembers: 2.5 })],
    ["members included as text", offer({ includedMembers: "10" })],
  ])("is nothing for %s, so the page never shows half a price list", (_why, value) => {
    expect(offerSummary(value)).toBeNull();
  });
});

describe("offerSummary taxInclusive", () => {
  it("says an offer includes tax only when the service says so", () => {
    const offer = { launch: false, includedMembers: 10, month: { base: { unitAmount: 4999, currency: "eur" }, member: { unitAmount: 499, currency: "eur" } }, year: { base: { unitAmount: 49990, currency: "eur" }, member: { unitAmount: 4990, currency: "eur" } } };
    expect(offerSummary({ ...offer, taxInclusive: true })).toMatchObject({ taxInclusive: true });
    expect(offerSummary({ ...offer, taxInclusive: "yes" })).toMatchObject({ taxInclusive: false });
  });
});
