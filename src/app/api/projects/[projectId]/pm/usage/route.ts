import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { pmDayUsage } from "@/lib/pm/day-usage";
import { MAX_STEPS } from "@/lib/pm/agent";

/**
 * What the PM has used on this project today: turns beside the model calls and the tokens, which are the gateway's usage rows.
 * A turn is up to `MAX_STEPS` round-trips, so the same hundred turns is anywhere between a hundred and fifteen hundred calls.
 */
export const GET = withProjectOwner(async (_request, { params, db }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await db.Project.findById(projectId, "pm").lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const usage = await pmDayUsage(db, projectId, project.pm ?? {});
  return NextResponse.json({
    turns: usage.turns,
    calls: usage.calls,
    tokens: usage.tokens,
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    stepLimitHits: usage.stepLimitHits,
    maxCallsPerTurn: MAX_STEPS,
  });
});
