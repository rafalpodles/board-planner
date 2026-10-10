export interface SubscriptionSummary {
  status: string | null;
  interval: "month" | "year" | null;
  launch: boolean;
  extraMembers: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  buyer: "business" | "consumer" | null;
  purchasedAt: string | null;
  withdrawnAt: string | null;
}

/** What a consumer who withdrew was refunded, for the subscription that ended by it */
export interface WithdrawalSummary {
  at: string;
  refunded: Money;
}

// `unreachable`: the licence service did not answer, which is not the same as taking no payments
/** The members a Pro subscription includes; every one above is billed */
export const INCLUDED_MEMBERS = 10;

export interface Money {
  amount: number;
  currency: string;
}

export interface PlanPrices {
  base: Money;
  member: Money;
}

/** What a checkout started now would charge, per billing period: the base price and what each member above the included ones adds */
export interface OfferSummary {
  launch: boolean;
  includedMembers: number;
  /** Every price already includes the tax Stripe charges */
  taxInclusive: boolean;
  month: PlanPrices;
  year: PlanPrices;
}

export type BillingSummary =
  | { available: false; unreachable?: true }
  | {
      available: true;
      launchOpen: boolean;
      subscription: SubscriptionSummary | null;
      memberPrice: Money | null;
      upcoming: Money | null;
      offer: OfferSummary | null;
      withdrawal: WithdrawalSummary | null;
      seller: { name: string; address: string } | null;
      termsVersion: string | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last moment a consumer may withdraw: the end of the fourteenth day after the purchase, in UTC; the licence service holds the same rule */
export function withdrawalEndsAt(purchasedAt: Date): Date {
  const day = new Date(purchasedAt.getTime() + 14 * DAY_MS);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59, 999));
}

/** Until when this subscription may be withdrawn from, or null when it may not be (any more) */
export function withdrawableUntil(subscription: SubscriptionSummary | null, now: Date = new Date()): Date | null {
  if (!subscription || subscription.buyer !== "consumer" || subscription.withdrawnAt || !subscription.purchasedAt) return null;
  const purchasedAt = new Date(subscription.purchasedAt);
  if (Number.isNaN(purchasedAt.getTime())) return null;
  const until = withdrawalEndsAt(purchasedAt);
  return now.getTime() <= until.getTime() ? until : null;
}

/** An amount in the currency's smallest unit and the currency, read from what the service says under `field` */
export function moneyOf(value: unknown, field: "unitAmount" | "amountDue" | "amount"): Money | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const amount = v[field];
  return typeof amount === "number" && Number.isFinite(amount) && typeof v.currency === "string" && /^[a-z]{3}$/i.test(v.currency) ? { amount, currency: v.currency.toLowerCase() } : null;
}

function planPricesOf(value: unknown): PlanPrices | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const base = moneyOf(v.base, "unitAmount");
  const member = moneyOf(v.member, "unitAmount");
  const priced = (money: Money | null): money is Money => !!money && Number.isInteger(money.amount) && money.amount >= 0;
  return priced(base) && priced(member) && base.currency === member.currency ? { base, member } : null;
}

/** What the licence service says a checkout would charge, or nothing unless every price is there and they are all in one currency */
export function offerSummary(value: unknown): OfferSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const month = planPricesOf(v.month);
  const year = planPricesOf(v.year);
  if (!month || !year || month.base.currency !== year.base.currency) return null;
  if (typeof v.includedMembers !== "number" || !Number.isInteger(v.includedMembers) || v.includedMembers < 1) return null;
  return { launch: v.launch === true, includedMembers: v.includedMembers, taxInclusive: v.taxInclusive === true, month, year };
}

/** What a withdrawal refunded, as the licence service says it */
export function withdrawalSummary(value: unknown): WithdrawalSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const refunded = moneyOf(v.refunded, "amount");
  return typeof v.at === "string" && refunded ? { at: v.at, refunded } : null;
}

/** What the licence service says an organisation pays, cut to the fields the page shows: nothing else it sends reaches the browser */
export function subscriptionSummary(value: unknown): SubscriptionSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    status: typeof v.status === "string" ? v.status : null,
    interval: v.interval === "month" || v.interval === "year" ? v.interval : null,
    launch: v.launch === true,
    extraMembers: typeof v.extraMembers === "number" && Number.isFinite(v.extraMembers) ? v.extraMembers : 0,
    currentPeriodEnd: typeof v.currentPeriodEnd === "string" ? v.currentPeriodEnd : null,
    cancelAtPeriodEnd: v.cancelAtPeriodEnd === true,
    buyer: v.buyer === "business" || v.buyer === "consumer" ? v.buyer : null,
    purchasedAt: typeof v.purchasedAt === "string" ? v.purchasedAt : null,
    withdrawnAt: typeof v.withdrawnAt === "string" ? v.withdrawnAt : null,
  };
}
