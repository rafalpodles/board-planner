export interface SubscriptionSummary {
  status: string | null;
  interval: "month" | "year" | null;
  launch: boolean;
  extraMembers: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
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
  month: PlanPrices;
  year: PlanPrices;
}

export type BillingSummary =
  | { available: false; unreachable?: true }
  | { available: true; launchOpen: boolean; subscription: SubscriptionSummary | null; memberPrice: Money | null; upcoming: Money | null; offer: OfferSummary | null };

/** An amount in the currency's smallest unit and the currency, read from what the service says under `field` */
export function moneyOf(value: unknown, field: "unitAmount" | "amountDue"): Money | null {
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
  return base && member && base.currency === member.currency ? { base, member } : null;
}

/** What the licence service says a checkout would charge, or nothing unless every price is there and they are all in one currency */
export function offerSummary(value: unknown): OfferSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const month = planPricesOf(v.month);
  const year = planPricesOf(v.year);
  if (!month || !year || month.base.currency !== year.base.currency) return null;
  if (typeof v.includedMembers !== "number" || !Number.isInteger(v.includedMembers) || v.includedMembers < 1) return null;
  return { launch: v.launch === true, includedMembers: v.includedMembers, month, year };
}

/** What the licence service says an organisation pays, cut to the six fields the page shows: nothing else it sends reaches the browser */
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
  };
}
