import { Types } from "mongoose";
import { PmMessage } from "@/models/pmMessage";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import { isValidTimezone, startOfDayInTimezone } from "@/lib/time";
import { resolveDailyTokenCap, resolveDailyTurnCap } from "./availability";

export async function isOverDailyTurnCap(
  projectId: string,
  pm: { dailyTurnCap?: number; autonomy?: { timezone?: string } }
): Promise<{ over: boolean; cap: number; used: number }> {
  const cap = await resolveDailyTurnCap(pm.dailyTurnCap);
  const zone = pm.autonomy?.timezone;
  const startOfDay = startOfDayInTimezone(
    new Date(),
    zone && isValidTimezone(zone) ? zone : DEFAULT_PM_AUTONOMY.timezone
  );
  const used = await PmMessage.countDocuments({
    project: projectId,
    role: "user",
    createdAt: { $gte: startOfDay },
  });
  return { over: used >= cap, cap, used };
}

export async function dailyPmSpend(
  projectId: string,
  pm: { dailyTokenCap?: number; autonomy?: { timezone?: string } }
): Promise<{ over: boolean; cap: number; tokens: number; calls: number; stepLimitHits: number }> {
  const cap = await resolveDailyTokenCap(pm.dailyTokenCap);
  const zone = pm.autonomy?.timezone;
  const startOfDay = startOfDayInTimezone(
    new Date(),
    zone && isValidTimezone(zone) ? zone : DEFAULT_PM_AUTONOMY.timezone
  );
  const [totals] = await PmMessage.aggregate<{
    tokens: number;
    calls: number;
    stepLimitHits: number;
  }>([
    { $match: { project: new Types.ObjectId(projectId), createdAt: { $gte: startOfDay } } },
    {
      $group: {
        _id: null,
        tokens: { $sum: { $ifNull: ["$usage.totalTokens", 0] } },
        calls: { $sum: { $ifNull: ["$usage.calls", 0] } },
        stepLimitHits: { $sum: { $cond: [{ $eq: ["$usage.hitStepLimit", true] }, 1, 0] } },
      },
    },
  ]);

  const tokens = totals?.tokens ?? 0;
  return {
    over: cap > 0 && tokens >= cap,
    cap,
    tokens,
    calls: totals?.calls ?? 0,
    stepLimitHits: totals?.stepLimitHits ?? 0,
  };
}
