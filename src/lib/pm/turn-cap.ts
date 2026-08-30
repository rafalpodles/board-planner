import { PmMessage } from "@/models/pmMessage";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import { isValidTimezone, startOfDayInTimezone } from "@/lib/time";
import { resolveDailyTurnCap } from "./availability";

/**
 * A turn is counted when it is *started*, and a turn the provider then refused is still one — the
 * message is stored, every later turn replays it, and `completion.type === "error"` cannot tell a
 * request that never connected from one that streamed and died. A cap that forgave failures would
 * let a flaky provider spend without limit, which is what the cap is for. The settings hint says
 * so, so the number on screen means what it says (BP-453).
 */
export async function isOverDailyTurnCap(
  projectId: string,
  pm: { dailyTurnCap?: number; autonomy?: { timezone?: string } }
): Promise<{ over: boolean; cap: number; used: number }> {
  const cap = await resolveDailyTurnCap(pm.dailyTurnCap);
  // The project's day, not the server's. Railway runs UTC, so a Warsaw board's allowance turned
  // over at 02:00 local and a 23:00 session was already spending tomorrow's. Same zone the
  // scheduled review reads, and the same default when a board never named one.
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
