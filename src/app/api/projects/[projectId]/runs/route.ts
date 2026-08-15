import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { AgentRun } from "@/models/agentRun";
import { toApiRun } from "@/lib/agent-service";
import { AGENT_RUN_OUTCOMES, AgentRunOutcome } from "@/types";

const MAX_DETAIL = 2000;

export const GET = withProjectAccessOrWorker(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);

  const runs = await AgentRun.find({ project: projectId })
    .sort({ finishedAt: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json(runs.map(toApiRun));
});

export const POST = withProjectAccessOrWorker(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const outcome = AGENT_RUN_OUTCOMES.find((o) => o === body.outcome) as AgentRunOutcome | undefined;
  if (!outcome) return NextResponse.json({ error: "Unknown outcome" }, { status: 400 });
  if (typeof body.taskId !== "string" || typeof body.taskKey !== "string") {
    return NextResponse.json({ error: "taskId and taskKey are required" }, { status: 400 });
  }

  const startedAt = new Date(body.startedAt ?? Date.now());
  const finishedAt = new Date(body.finishedAt ?? Date.now());

  // The reason a gate gave carries build output and model prose, and this is a durable sink; it
  // gets the same length bound the board path already applies.
  const detail = typeof body.detail === "string" ? body.detail.slice(0, MAX_DETAIL) : "";

  const run = await AgentRun.create({
    project: projectId,
    task: body.taskId,
    taskKey: body.taskKey,
    worker: body.workerId ?? null,
    agent: body.agentId ?? null,
    agentName: typeof body.agentName === "string" ? body.agentName : "",
    outcome,
    refusedBy: typeof body.refusedBy === "string" ? body.refusedBy : "",
    detail,
    startedAt: Number.isNaN(startedAt.valueOf()) ? new Date() : startedAt,
    finishedAt: Number.isNaN(finishedAt.valueOf()) ? new Date() : finishedAt,
    costUsd: typeof body.costUsd === "number" && body.costUsd >= 0 ? body.costUsd : 0,
  });

  return NextResponse.json(toApiRun(run.toObject()), { status: 201 });
});
