import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { dailyPmSpend, isOverDailyTurnCap } from "@/lib/pm/turn-cap";
import { MAX_STEPS } from "@/lib/pm/agent";

/**
 * What the PM has spent on this project today (BP-284).
 *
 * `pm.dailyTurnCap` was the only number on the settings screen, and it is the one that does not
 * answer the question a cap is asked: a turn is up to `MAX_STEPS` round-trips, so the same hundred
 * turns is anywhere between a hundred and fifteen hundred model calls. This is what makes the
 * difference legible — turns beside calls beside tokens, in the operator's own units.
 */
export const GET = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "pm").lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const [turns, spend] = await Promise.all([
    isOverDailyTurnCap(projectId, project.pm ?? {}),
    dailyPmSpend(projectId, project.pm ?? {}),
  ]);

  return NextResponse.json({
    turns: { used: turns.used, cap: turns.cap },
    calls: spend.calls,
    tokens: spend.tokens,
    // What the cached figure is a share OF. A cache read is part of the prompt count, never of the
    // completion, so dividing by the day's total would understate the hit rate by whatever the
    // model wrote — badly on a chatty board (BP-568 review).
    promptTokens: spend.promptTokens,
    // A share of `promptTokens`, not an addition to anything: what the provider served from cache.
    // Without this every token reads as a cold prompt and the budget above is set from a number
    // that cannot tell a cache hit from a miss (BP-568).
    cachedTokens: spend.cachedTokens,
    // Reported beside the two, never inside either — what a cache write cost is the provider's
    // own accounting and is not documented as part of the prompt count
    cacheWriteTokens: spend.cacheWriteTokens,
    tokenCap: spend.cap,
    // Turns that ran out of steps rather than finishing — the most expensive shape a turn takes,
    // and an event the operator may want to hear about on its own
    stepLimitHits: spend.stepLimitHits,
    maxCallsPerTurn: MAX_STEPS,
  });
});
