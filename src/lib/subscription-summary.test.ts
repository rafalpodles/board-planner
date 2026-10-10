import { describe, it, expect } from "vitest";
import { moneyOf, offerSummary, subscriptionSummary, withdrawableUntil, withdrawalEndsAt, withdrawalSummary, type SubscriptionSummary } from "./subscription-summary";

// BP-676
describe("subscriptionSummary", () => {
  it("keeps the fields the page shows and drops everything else the service sends", () => {
    expect(
      subscriptionSummary({
        status: "active",
        interval: "year",
        launch: true,
        extraMembers: 3,
        currentPeriodEnd: "2026-11-08T21:00:00.000Z",
        cancelAtPeriodEnd: true,
        buyer: "consumer",
        purchasedAt: "2026-10-03T22:40:00.000Z",
        withdrawnAt: null,
        stripeCustomerId: "cus_secret",
        anything: 1,
      })
    ).toEqual({
      status: "active",
      interval: "year",
      launch: true,
      extraMembers: 3,
      currentPeriodEnd: "2026-11-08T21:00:00.000Z",
      cancelAtPeriodEnd: true,
      buyer: "consumer",
      purchasedAt: "2026-10-03T22:40:00.000Z",
      withdrawnAt: null,
    });
  });

  it("is null for no subscription, and reads what is wrongly typed as nothing", () => {
    expect(subscriptionSummary(null)).toBeNull();
    expect(subscriptionSummary("active")).toBeNull();
    expect(subscriptionSummary({ status: 5, interval: "week", launch: "yes", extraMembers: "3", currentPeriodEnd: 9, cancelAtPeriodEnd: 1, buyer: "person", purchasedAt: 1, withdrawnAt: true })).toEqual({
      status: null,
      interval: null,
      launch: false,
      extraMembers: 0,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      buyer: null,
      purchasedAt: null,
      withdrawnAt: null,
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

// BP-941
describe("withdrawal", () => {
  const purchasedAt = "2026-10-03T22:40:00.000Z";
  const consumer = (over: Partial<SubscriptionSummary> = {}): SubscriptionSummary => ({
    status: "active",
    interval: "month",
    launch: false,
    extraMembers: 0,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    buyer: "consumer",
    purchasedAt,
    withdrawnAt: null,
    ...over,
  });

  it("ends with the fourteenth day after the purchase, in UTC, as the licence service counts it", () => {
    expect(withdrawalEndsAt(new Date(purchasedAt))).toEqual(new Date("2026-10-17T23:59:59.999Z"));
  });

  it("is open to a consumer to the last millisecond of that day, and closed after it", () => {
    expect(withdrawableUntil(consumer(), new Date("2026-10-17T23:59:59.999Z"))).toEqual(new Date("2026-10-17T23:59:59.999Z"));
    expect(withdrawableUntil(consumer(), new Date("2026-10-18T00:00:00.000Z"))).toBeNull();
  });

  it("is never open to a business, a subscription with no buyer or purchase day, or one already withdrawn from", () => {
    const now = new Date("2026-10-05T00:00:00.000Z");
    expect(withdrawableUntil(consumer({ buyer: "business" }), now)).toBeNull();
    expect(withdrawableUntil(consumer({ buyer: null }), now)).toBeNull();
    expect(withdrawableUntil(consumer({ purchasedAt: null }), now)).toBeNull();
    expect(withdrawableUntil(consumer({ purchasedAt: "soon" }), now)).toBeNull();
    expect(withdrawableUntil(consumer({ withdrawnAt: "2026-10-04T00:00:00.000Z" }), now)).toBeNull();
    expect(withdrawableUntil(null, now)).toBeNull();
  });

  it("reads what a withdrawal refunded, and nothing that is not one", () => {
    expect(withdrawalSummary({ at: "2026-10-08T10:00:00.000Z", refunded: { amount: 3812, currency: "EUR" }, refunds: ["re_1"] })).toEqual({ at: "2026-10-08T10:00:00.000Z", refunded: { amount: 3812, currency: "eur" } });
    expect(withdrawalSummary({ at: "2026-10-08T10:00:00.000Z" })).toBeNull();
    expect(withdrawalSummary(null)).toBeNull();
  });

  it("says an offer includes tax only when the service says so", () => {
    const offer = { launch: false, includedMembers: 10, month: { base: { unitAmount: 4999, currency: "eur" }, member: { unitAmount: 499, currency: "eur" } }, year: { base: { unitAmount: 49990, currency: "eur" }, member: { unitAmount: 4990, currency: "eur" } } };
    expect(offerSummary({ ...offer, taxInclusive: true })).toMatchObject({ taxInclusive: true });
    expect(offerSummary({ ...offer, taxInclusive: "yes" })).toMatchObject({ taxInclusive: false });
  });
});
