import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { dailyPmSpend, isOverDailyTurnCap } from "@/lib/pm/turn-cap";
import { MAX_STEPS } from "@/lib/pm/agent";

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
    tokenCap: spend.cap,
    stepLimitHits: spend.stepLimitHits,
    maxCallsPerTurn: MAX_STEPS,
  });
});
