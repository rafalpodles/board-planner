import { ENTITLEMENT_GRACE_MS } from "./entitlements";

export const PLAN_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanNotice =
  | { kind: "free" }
  | { kind: "pro" }
  | { kind: "ending"; endsAt: string; daysLeft: number }
  | { kind: "grace"; endedAt: string; graceEndsAt: string };

export function planNotice(plan: { plan: "free" | "pro"; planEndsAt: string | null }, now = Date.now()): PlanNotice {
  if (plan.plan === "free") return { kind: "free" };
  const endsAt = plan.planEndsAt ? Date.parse(plan.planEndsAt) : NaN;
  if (Number.isNaN(endsAt)) return { kind: "pro" };
  if (now > endsAt) return { kind: "grace", endedAt: plan.planEndsAt!, graceEndsAt: new Date(endsAt + ENTITLEMENT_GRACE_MS).toISOString() };
  const daysLeft = Math.ceil((endsAt - now) / DAY_MS);
  return daysLeft <= PLAN_WARNING_DAYS ? { kind: "ending", endsAt: plan.planEndsAt!, daysLeft } : { kind: "pro" };
}

export function formatPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
