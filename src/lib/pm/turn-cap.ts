import { PmMessage } from "@/models/pmMessage";
import { resolveDailyTurnCap } from "./availability";

export async function isOverDailyTurnCap(
  projectId: string,
  pm: { dailyTurnCap?: number }
): Promise<{ over: boolean; cap: number; used: number }> {
  const cap = await resolveDailyTurnCap(pm.dailyTurnCap);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const used = await PmMessage.countDocuments({
    project: projectId,
    role: "user",
    createdAt: { $gte: startOfDay },
  });
  return { over: used >= cap, cap, used };
}
