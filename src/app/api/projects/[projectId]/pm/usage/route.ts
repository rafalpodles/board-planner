import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
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
export const GET = withProjectAccess(async (_request, { params }) => {
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
    tokenCap: spend.cap,
    // Turns that ran out of steps rather than finishing — the most expensive shape a turn takes,
    // and an event the operator may want to hear about on its own
    stepLimitHits: spend.stepLimitHits,
    maxCallsPerTurn: MAX_STEPS,
  });
});
