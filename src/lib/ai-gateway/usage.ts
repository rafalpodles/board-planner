import type { ScopedDb } from "@/lib/db-scope";
import { duplicateKeyField } from "@/lib/mongo-errors";
import type { OrUsage } from "@/lib/pm/openrouter";
import type { IAiUsage } from "@/models/aiUsage";
import type { AiBudgetKind } from "@/models/aiBudget";
import { periodOf } from "./periods";

export interface UsageEntry {
  source: IAiUsage["source"];
  keySource: IAiUsage["keySource"];
  projectId?: string;
  userId?: string;
  model: string;
  /** Absent when the provider reported none: the call is still counted, as a call of unknown size */
  usage?: OrUsage;
}

/** Two first calls of a period insert the same counter at once: the loser meets the winner's row, which its second try adds to */
async function add(db: ScopedDb, kind: AiBudgetKind, period: string, inc: Record<string, number>): Promise<void> {
  const write = () => db.AiBudget.updateOne({ kind, period }, { $inc: inc }, { upsert: true });
  try {
    await write();
  } catch (error) {
    if (duplicateKeyField(error) === null) throw error;
    await write();
  }
}

/**
 * One row for the call, and its tokens added to the organisation's counters: today's, and the trial's or the month's.
 * Calls on the operator's key count towards the limits; calls on the organisation's own key are counted apart and never limited.
 */
export async function recordUsage(db: ScopedDb, entry: UsageEntry, counter: "trial" | "month", now: Date = new Date()): Promise<void> {
  const usage = entry.usage;
  const total = Number.isFinite(usage?.totalTokens) ? Math.max(0, usage!.totalTokens) : 0;
  const inc: Record<string, number> = entry.keySource === "own" ? { ownTokens: total, ownCalls: 1 } : { tokens: total, calls: 1 };
  // The counters are what the limits are made of and the row is only the log: a row that fails to write must not keep the tokens out
  await Promise.all([add(db, "day", periodOf("day", now), inc), add(db, counter, periodOf(counter, now), inc)]);
  await db.AiUsage.create({
    ...(entry.projectId ? { project: entry.projectId } : {}),
    ...(entry.userId ? { user: entry.userId } : {}),
    source: entry.source,
    keySource: entry.keySource,
    model: entry.model,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: total,
    cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  });
}
