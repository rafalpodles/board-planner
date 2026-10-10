import { Types } from "mongoose";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import { isValidTimezone, startOfDayInTimezone } from "@/lib/time";
import type { ScopedDb } from "@/lib/db-scope";

export interface PmDayUsage {
  turns: number;
  calls: number;
  tokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  stepLimitHits: number;
}

/**
 * What the PM has used on this project today, in the project's own day. Tokens and calls are the gateway's usage rows, the
 * same ones the organisation's allowance is made of; turns and the turns that ran out of steps are counted from the thread.
 */
export async function pmDayUsage(db: ScopedDb, projectId: string, pm: { autonomy?: { timezone?: string } }): Promise<PmDayUsage> {
  const zone = pm.autonomy?.timezone;
  const startOfDay = startOfDayInTimezone(new Date(), zone && isValidTimezone(zone) ? zone : DEFAULT_PM_AUTONOMY.timezone);
  const project = new Types.ObjectId(projectId);

  const [turns, [totals], [steps]] = await Promise.all([
    db.PmMessage.countDocuments({ project: projectId, role: "user", createdAt: { $gte: startOfDay } }),
    db.AiUsage.aggregate<{ tokens: number; promptTokens: number; cachedTokens: number; cacheWriteTokens: number; calls: number }>([
      { $match: { project, source: "pm", createdAt: { $gte: startOfDay } } },
      {
        $group: {
          _id: null,
          tokens: { $sum: "$totalTokens" },
          // A cache read is a share of THIS, not of the day's total
          promptTokens: { $sum: "$promptTokens" },
          cachedTokens: { $sum: "$cachedPromptTokens" },
          cacheWriteTokens: { $sum: "$cacheWriteTokens" },
          calls: { $sum: 1 },
        },
      },
    ]),
    db.PmMessage.aggregate<{ hits: number }>([
      { $match: { project, "usage.hitStepLimit": true, createdAt: { $gte: startOfDay } } },
      { $count: "hits" },
    ]),
  ]);

  const cachedTokens = totals?.cachedTokens ?? 0;
  const promptTokens = totals?.promptTokens ?? 0;
  // A cache read is documented as part of the prompt count: a provider that counts it outside makes the day understate what was billed
  if (cachedTokens > promptTokens) {
    console.warn(
      `[pm] project ${projectId}: ${cachedTokens} cached tokens reported against ${promptTokens} prompt ` +
        `tokens — the provider is counting cache reads outside its prompt total, so the day's spend is understated`
    );
  }
  return {
    turns,
    calls: totals?.calls ?? 0,
    tokens: totals?.tokens ?? 0,
    promptTokens,
    cachedTokens,
    cacheWriteTokens: totals?.cacheWriteTokens ?? 0,
    stepLimitHits: steps?.hits ?? 0,
  };
}
