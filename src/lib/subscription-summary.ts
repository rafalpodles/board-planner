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

export type BillingSummary =
  | { available: false; unreachable?: true }
  | { available: true; launchOpen: boolean; subscription: SubscriptionSummary | null; memberPrice: Money | null; upcoming: Money | null };

/** An amount in the currency's smallest unit and the currency, read from what the service says under `field` */
export function moneyOf(value: unknown, field: "unitAmount" | "amountDue"): Money | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const amount = v[field];
  return typeof amount === "number" && Number.isFinite(amount) && typeof v.currency === "string" && /^[a-z]{3}$/i.test(v.currency) ? { amount, currency: v.currency.toLowerCase() } : null;
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
