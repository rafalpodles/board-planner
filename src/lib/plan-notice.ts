import { ENTITLEMENT_GRACE_MS } from "./entitlements";

export const PLAN_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe takes a renewal's payment up to an hour after the period ends: a renewing key a day past its end is a failed payment
export const RENEWAL_SETTLE_MS = DAY_MS;

export type PlanNotice =
  | { kind: "free" }
  | { kind: "pro" }
  // `cancelled`: a subscription that will not renew, which is told as soon as it is cancelled, not in the last month
  | { kind: "ending"; endsAt: string; daysLeft: number; cancelled: boolean }
  // `paymentFailed`: a subscription that should have renewed and did not; the days are what the retries have
  | { kind: "grace"; endedAt: string; graceEndsAt: string; paymentFailed: boolean };

export function planNotice(
  plan: { plan: "free" | "pro"; planEndsAt: string | null; trial?: boolean; subscription?: "renewing" | "ending" | null },
  now = Date.now()
): PlanNotice {
  if (plan.plan === "free") return { kind: "free" };
  const endsAt = plan.planEndsAt ? Date.parse(plan.planEndsAt) : NaN;
  if (Number.isNaN(endsAt)) return { kind: "pro" };
  // The server has already put an ended trial, or a cancelled subscription, on Free; a client whose clock runs ahead must agree
  if (now > endsAt && (plan.trial || plan.subscription === "ending")) return { kind: "free" };
  // The server has put whatever is past its grace on Free; a client whose clock runs ahead must agree
  if (now > endsAt + ENTITLEMENT_GRACE_MS) return { kind: "free" };
  if (now > endsAt) {
    if (plan.subscription === "renewing" && now - endsAt < RENEWAL_SETTLE_MS) return { kind: "pro" };
    return { kind: "grace", endedAt: plan.planEndsAt!, graceEndsAt: new Date(endsAt + ENTITLEMENT_GRACE_MS).toISOString(), paymentFailed: plan.subscription === "renewing" };
  }
  const daysLeft = Math.ceil((endsAt - now) / DAY_MS);
  // A subscription that renews by itself has nothing to warn about until a payment fails
  if (plan.subscription === "renewing") return { kind: "pro" };
  if (plan.subscription === "ending") return { kind: "ending", endsAt: plan.planEndsAt!, daysLeft, cancelled: true };
  return daysLeft <= PLAN_WARNING_DAYS ? { kind: "ending", endsAt: plan.planEndsAt!, daysLeft, cancelled: false } : { kind: "pro" };
}

export function formatPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function graceDaysLeft(graceEndsAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(graceEndsAt) - now) / DAY_MS));
}
