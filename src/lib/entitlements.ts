export const FEATURE_KEYS = [
  "ai.pm_agent",
  "ai.task_generation",
  "ai.byok",
  "integrations.coda",
  "integrations.jira",
  "audit.export",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type Plan = "free" | "pro";

// A plan is a named set of keys and nothing else — "pro" grants every feature that exists.
export const PRO_FEATURES: readonly FeatureKey[] = FEATURE_KEYS;

// Reused by the licence slice: an expired key still works for this long before `can()` turns it off.
export const ENTITLEMENT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface EntitlementGate {
  entitlements: {
    plan: Plan;
    features: string[];
    expiresAt?: Date | null;
  };
}

export function can(tenant: EntitlementGate, feature: FeatureKey): boolean {
  const { entitlements } = tenant;

  if (entitlements.expiresAt && Date.now() > entitlements.expiresAt.getTime() + ENTITLEMENT_GRACE_MS) {
    return false;
  }

  const granted: readonly string[] =
    entitlements.plan === "pro" ? PRO_FEATURES : entitlements.features;
  return granted.includes(feature);
}
