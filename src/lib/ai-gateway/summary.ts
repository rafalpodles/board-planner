import type { ScopedDb } from "@/lib/db-scope";
import { can } from "@/lib/entitlements";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import { counterKindOf } from "./budget";
import { budgetOf, operatorAllowance } from "./limits";
import { nextUtcMonth, periodOf, startOfUtcMonth } from "./periods";

export interface AiUsageSummary {
  /** The counter the allowance is read from: a trial's own, or the UTC month */
  scope: "month" | "trial";
  /** Tokens on the operator's key in that scope */
  used: number;
  /** The allowance, or null where nothing limits it */
  limit: number | null;
  /** When the month's counter starts again; a trial's does not */
  resetsAt: string | null;
  /** Tokens on the operator's key today (UTC) */
  today: number;
  /** What one UTC day may use, or null where there is no ceiling */
  dailyCeiling: number | null;
  /** Tokens on the organisation's own key in that scope: counted, never limited */
  ownTokens: number;
  /** Calls on the operator's key in that scope, and on the organisation's own key */
  calls: number;
  ownCalls: number;
  /** PM turns people or the schedule started in that scope; null where it was not asked, which costs a count */
  turns: number | null;
  /** The operator has switched off the use of its key for this organisation */
  locked: boolean;
  /** The operator's own figure, set for the counter this organisation is on now, is the one in force (BP-678) */
  overridden: boolean;
  /** The service has a key and this organisation may use it: a plan that includes it, or a self-hosted instance's own */
  included: boolean;
}

/** What an organisation has used of its AI allowance, for its own Settings and for the operator's list */
export async function aiUsageSummary(db: ScopedDb, now: Date = new Date(), options: { turns?: boolean } = {}): Promise<AiUsageSummary> {
  const [organisation, budget] = await Promise.all([getOrganisation(db.organisation), budgetOf(db)]);
  const scope = budget?.scope ?? (await counterKindOf(db));
  const rows = await db.AiBudget.find({
    $or: [
      { kind: "day", period: periodOf("day", now) },
      { kind: scope, period: periodOf(scope, now) },
    ],
  }).lean();
  const row = (kind: string) => rows.find((r) => r.kind === kind);
  const turns = options.turns
    ? await db.PmMessage.countDocuments({ role: "user", ...(scope === "month" ? { createdAt: { $gte: startOfUtcMonth(now) } } : {}) })
    : null;

  // An organisation on a plan without managed AI, or on an instance with no key to offer, has no allowance: the key is its own or nothing
  const included = Boolean(process.env.OPENROUTER_API_KEY) && (organisationDomain() === null || can(organisation, "ai.managed"));
  return {
    scope,
    used: row(scope)?.tokens ?? 0,
    limit: included ? budget?.limit ?? null : null,
    resetsAt: scope === "month" ? nextUtcMonth(now).toISOString() : null,
    today: row("day")?.tokens ?? 0,
    dailyCeiling: included && budget && budget.dailyCeiling > 0 ? budget.dailyCeiling : null,
    ownTokens: row(scope)?.ownTokens ?? 0,
    calls: row(scope)?.calls ?? 0,
    ownCalls: row(scope)?.ownCalls ?? 0,
    turns,
    locked: Boolean(organisation.aiLockedAt),
    overridden: operatorAllowance(organisation.aiAllowance, scope) !== undefined,
    included,
  };
}
