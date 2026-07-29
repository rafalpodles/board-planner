import { PmMessage } from "@/models/pmMessage";

const FALLBACK_DAILY_TURN_CAP = 100;

export async function isOverDailyTurnCap(
  projectId: string,
  pm: { dailyTurnCap?: number }
): Promise<{ over: boolean; cap: number; used: number }> {
  const cap = pm.dailyTurnCap || Number(process.env.PM_DAILY_TURN_CAP) || FALLBACK_DAILY_TURN_CAP;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await PmMessage.countDocuments({
    project: projectId,
    role: "user",
    createdAt: { $gte: startOfDay },
  });
  return { over: used >= cap, cap, used };
}
