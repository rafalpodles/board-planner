import type { ScopedDb } from "@/lib/db-scope";
import type { AiBudgetKind } from "@/models/aiBudget";
import { getOrganisation } from "@/lib/organisation";
import { budgetOf } from "./limits";
import { nextUtcMidnight, nextUtcMonth, periodOf } from "./periods";

export interface BudgetRefusal {
  scope: AiBudgetKind;
  used: number;
  limit: number;
  /** When the counter starts again, or null where it does not (a trial's ends with the trial) */
  resetsAt: Date | null;
}

/** Which counter an organisation's calls are added to for the screen and the limit: a trial's own, or the month's */
export async function counterKindOf(db: ScopedDb): Promise<"trial" | "month"> {
  const { entitlements } = await getOrganisation(db.organisation);
  return entitlements.plan === "pro" && entitlements.trial === true ? "trial" : "month";
}

/**
 * Refuses a call on the operator's key once the organisation has spent what it may: its allowance (trial or month) first,
 * then today's ceiling. Nothing here is shared with another organisation: a counter belongs to one, so one that is over
 * is the only one refused.
 */
export async function checkBudget(db: ScopedDb, now: Date = new Date()): Promise<{ refusal: BudgetRefusal | null; counter: "trial" | "month" }> {
  const budget = await budgetOf(db);
  if (!budget) return { refusal: null, counter: await counterKindOf(db) };

  const rows = await db.AiBudget.find({
    $or: [
      { kind: "day", period: periodOf("day", now) },
      { kind: budget.scope, period: periodOf(budget.scope, now) },
    ],
  }).lean();
  const spent = (kind: AiBudgetKind) => rows.find((row) => row.kind === kind)?.tokens ?? 0;

  const allowance = spent(budget.scope);
  if (allowance >= budget.limit) {
    return {
      counter: budget.scope,
      refusal: { scope: budget.scope, used: allowance, limit: budget.limit, resetsAt: budget.scope === "month" ? nextUtcMonth(now) : null },
    };
  }
  const today = spent("day");
  if (budget.dailyCeiling > 0 && today >= budget.dailyCeiling) {
    return { counter: budget.scope, refusal: { scope: "day", used: today, limit: budget.dailyCeiling, resetsAt: nextUtcMidnight(now) } };
  }
  return { refusal: null, counter: budget.scope };
}
