export interface SubscriptionSummary {
  status: string | null;
  interval: "month" | "year" | null;
  launch: boolean;
  extraMembers: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

// `unreachable`: the licence service did not answer, which is not the same as taking no payments
export type BillingSummary = { available: false; unreachable?: true } | { available: true; launchOpen: boolean; subscription: SubscriptionSummary | null };

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
