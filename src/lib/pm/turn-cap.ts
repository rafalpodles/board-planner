import { Types } from "mongoose";
import { PmMessage } from "@/models/pmMessage";
import { DEFAULT_PM_AUTONOMY } from "@/types";
import { isValidTimezone, startOfDayInTimezone } from "@/lib/time";
import { resolveDailyTokenCap, resolveDailyTurnCap } from "./availability";

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

/**
 * What the PM has spent on this project today, and whether that is over the token ceiling.
 *
 * Derived from the stored turns rather than accumulated into the project, exactly as the turn count
 * above is: there is no counter to drift, no migration, and a turn deleted from the thread stops
 * counting against the day the same way it stops counting as a turn.
 *
 * `calls` is reported beside the tokens because it is the number the turn cap was mistaken for —
 * seeing "40 turns, 380 calls" is what makes the difference legible (BP-284).
 */
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
        // Turns that ran out of steps rather than finishing — the most expensive shape a turn has
        stepLimitHits: { $sum: { $cond: [{ $eq: ["$usage.hitStepLimit", true] }, 1, 0] } },
      },
    },
  ]);

  const tokens = totals?.tokens ?? 0;
  return {
    // A cap of 0 is no cap: `over` must not become true for every project the moment this ships
    over: cap > 0 && tokens >= cap,
    cap,
    tokens,
    calls: totals?.calls ?? 0,
    stepLimitHits: totals?.stepLimitHits ?? 0,
  };
}
