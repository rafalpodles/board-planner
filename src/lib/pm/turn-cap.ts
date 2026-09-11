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
): Promise<{
  over: boolean;
  cap: number;
  tokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  calls: number;
  stepLimitHits: number;
}> {
  const cap = await resolveDailyTokenCap(pm.dailyTokenCap);
  const zone = pm.autonomy?.timezone;
  const startOfDay = startOfDayInTimezone(
    new Date(),
    zone && isValidTimezone(zone) ? zone : DEFAULT_PM_AUTONOMY.timezone
  );
  const [totals] = await PmMessage.aggregate<{
    tokens: number;
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    calls: number;
    stepLimitHits: number;
  }>([
    { $match: { project: new Types.ObjectId(projectId), createdAt: { $gte: startOfDay } } },
    {
      $group: {
        _id: null,
        tokens: { $sum: { $ifNull: ["$usage.totalTokens", 0] } },
        // Not reported — summed only so the cache-read premise below can be checked against the
        // number it is actually a premise about
        promptTokens: { $sum: { $ifNull: ["$usage.promptTokens", 0] } },
        // Already inside `tokens`, reported apart from it so the operator can see what share of
        // the day was billed at cache-read price rather than as a cold prompt (BP-568). Turns
        // stored before this shipped carry neither field, and $ifNull reads those as 0 — which
        // is what "we did not measure it" and "nothing was cached" both look like on that day.
        cachedTokens: { $sum: { $ifNull: ["$usage.cachedPromptTokens", 0] } },
        cacheWriteTokens: { $sum: { $ifNull: ["$usage.cacheWriteTokens", 0] } },
        calls: { $sum: { $ifNull: ["$usage.calls", 0] } },
        // Turns that ran out of steps rather than finishing — the most expensive shape a turn has
        stepLimitHits: { $sum: { $cond: [{ $eq: ["$usage.hitStepLimit", true] }, 1, 0] } },
      },
    },
  ]);

  const tokens = totals?.tokens ?? 0;
  const cachedTokens = totals?.cachedTokens ?? 0;
  /**
   * The premise this reporting rests on is the provider's, not ours: a cache read is documented as
   * part of `prompt_tokens`. A provider counting it outside would make the day's spend understate
   * what was billed while the settings screen still rendered a plausible share. Nothing on screen
   * could show that, so it goes to the log — the operator is not the one who can act on it.
   *
   * Compared against the PROMPT total, not the day's total. A day of 400k prompt and 300k
   * completion tokens reporting 600k cached has broken the premise by 200k, and against
   * prompt + completion it would look fine and say nothing (BP-568 review).
   */
  const promptTokens = totals?.promptTokens ?? 0;
  if (cachedTokens > promptTokens) {
    console.warn(
      `[pm] project ${projectId}: ${cachedTokens} cached tokens reported against ${promptTokens} prompt ` +
        `tokens — the provider is counting cache reads outside its prompt total, so the day's spend is understated`
    );
  }
  return {
    // A cap of 0 is no cap: `over` must not become true for every project the moment this ships
    over: cap > 0 && tokens >= cap,
    cap,
    tokens,
    cachedTokens,
    cacheWriteTokens: totals?.cacheWriteTokens ?? 0,
    calls: totals?.calls ?? 0,
    stepLimitHits: totals?.stepLimitHits ?? 0,
  };
}
