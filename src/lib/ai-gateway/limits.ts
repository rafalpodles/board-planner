import type { ScopedDb } from "@/lib/db-scope";
import { memberCounts } from "@/lib/member-limit";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { INCLUDED_MEMBERS } from "@/lib/subscription-summary";
import type { AiBudgetKind } from "@/models/aiBudget";

export const HOSTED_DEFAULTS = {
  AI_TRIAL_TOKENS: 3_000_000,
  AI_MONTHLY_TOKENS: 15_000_000,
  AI_MEMBER_TOKENS: 1_000_000,
  AI_DAILY_PERCENT: 20,
} as const;

type LimitVariable = keyof typeof HOSTED_DEFAULTS;

/** A number in the environment applies anywhere and 0 turns it off; unset, the hosted default applies on a hosted instance only */
export function limitFromEnv(name: LimitVariable): number {
  const raw = process.env[name]?.trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    console.warn(`${name}=${JSON.stringify(raw)} is not a number of at least 0; using the default`);
  }
  return organisationDomain() !== null ? HOSTED_DEFAULTS[name] : 0;
}

export interface Budget {
  /** The counter the limit is read from: a trial's own, or the UTC month */
  scope: Exclude<AiBudgetKind, "day">;
  /** Tokens on the operator's key in that scope; never 0 here, a budget that is off is `null` */
  limit: number;
  /** Tokens on the operator's key in one UTC day, or 0 for no ceiling */
  dailyCeiling: number;
  /** When a trial ends, which is when its allowance does */
  endsAt?: Date;
}

/**
 * What an organisation may spend of the operator's key, or null for no limit (a self-hosted instance that set none, an
 * organisation whose limit is switched off). The trial's allowance is for the whole trial; a paid plan's is for the UTC
 * month and grows by what each member above the included ones brings.
 */
export async function budgetOf(db: ScopedDb): Promise<Budget | null> {
  const { entitlements } = await getOrganisation(db.organisation);
  const trial = entitlements.plan === "pro" && entitlements.trial === true;

  let limit: number;
  if (trial) {
    limit = limitFromEnv("AI_TRIAL_TOKENS");
  } else {
    limit = limitFromEnv("AI_MONTHLY_TOKENS");
    const perMember = limitFromEnv("AI_MEMBER_TOKENS");
    if (limit > 0 && perMember > 0) {
      const { active } = await memberCounts(db);
      limit += perMember * Math.max(0, active - INCLUDED_MEMBERS);
    }
  }
  if (limit <= 0) return null;

  const percent = limitFromEnv("AI_DAILY_PERCENT");
  return {
    scope: trial ? "trial" : "month",
    limit,
    dailyCeiling: percent > 0 ? Math.max(1, Math.ceil((limit * Math.min(percent, 100)) / 100)) : 0,
    ...(trial && entitlements.expiresAt ? { endsAt: entitlements.expiresAt } : {}),
  };
}
