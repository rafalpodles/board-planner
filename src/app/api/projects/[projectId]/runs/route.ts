import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccessOrWorker } from "@/lib/middleware";
import { AgentRun } from "@/models/agentRun";
import { toApiRun } from "@/lib/agent-service";
import { Types } from "mongoose";
import { AGENT_RUN_OUTCOMES, AgentRunOutcome, IAgentRun } from "@/types";

const MAX_DETAIL = 2000;
// A key and an agent's name, both of which a member can post directly. Far past anything the
// worker sends, and short enough that a record cannot be made a sink.
const MAX_NAME = 200;

export const GET = withProjectAccessOrWorker(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const url = new URL(request.url);
  // Number("") is 0 and Mongoose reads .limit(0) as no limit at all, so a blank parameter used to
  // return every run in the project.
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 100) : 20;

  const runs = await AgentRun.find({ project: projectId })
    .sort({ finishedAt: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json(runs.map(toApiRun));
});

export const POST = withProjectAccessOrWorker(async (request, { params, workerId: caller }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();
  const outcome = AGENT_RUN_OUTCOMES.find((o) => o === body.outcome) as AgentRunOutcome | undefined;
  if (!outcome) return NextResponse.json({ error: "Unknown outcome" }, { status: 400 });
  if (typeof body.taskId !== "string" || typeof body.taskKey !== "string") {
    return NextResponse.json({ error: "taskId and taskKey are required" }, { status: 400 });
  }

  // The same cross-project reference BP-314 closed for sprints: a member of one board could
  // otherwise write history naming another board's task or agent.
  const { Task } = await import("@/models/task");
  if (!Types.ObjectId.isValid(body.taskId)) {
    return NextResponse.json({ error: "taskId is not an id" }, { status: 400 });
  }
  if (!(await Task.exists({ _id: body.taskId, project: projectId }))) {
    return NextResponse.json({ error: "That task is not on this project" }, { status: 400 });
  }

  let agentId: string | null = null;
  if (typeof body.agentId === "string" && Types.ObjectId.isValid(body.agentId)) {
    const { Agent } = await import("@/models/agent");
    const agent = await Agent.findById(body.agentId, "scope project").lean();
    const usable = agent && (agent.scope !== "project" || String(agent.project) === String(projectId));
    if (usable) agentId = body.agentId;
  }

  // Never later than now: the newest record is the one the next claim reads its rejection reason
  // from, so a record dated in the future would speak for every run after it
  const now = new Date();
  const notAfterNow = (value: unknown) => {
    const date = new Date((value as string | number | undefined) ?? now);
    return Number.isNaN(date.valueOf()) || date > now ? now : date;
  };

  // The reason a gate gave carries build output and model prose, and this is a durable sink; it
  // gets the same length bound the board path already applies.
  const detail = typeof body.detail === "string" ? body.detail.slice(0, MAX_DETAIL) : "";

  // The caller the middleware verified, never `body.workerId`: that field is whatever the sender
  // typed, and on the person branch there is no machine behind it at all. A member of the board
  // could attribute a run to any machine on the instance, and `toFleetRun` carries the machine —
  // so a forged machineFault arrived on an instance admin's fleet screen as that machine's
  // (found in review). The worker still sends the field and it is still the same id; it is simply
  // not the source any more.
  const workerId = caller && Types.ObjectId.isValid(caller) ? caller : null;
  // A machine's only; a person's record carries none. Keyed with the machine too, so one machine
  // naming another's run cannot take the place of that machine's own record.
  const runId = workerId && typeof body.runId === "string" ? body.runId : undefined;
  const recorded = () =>
    AgentRun.findOne({ task: body.taskId, runId, worker: workerId }).lean<IAgentRun>();

  if (runId) {
    const existing = await recorded();
    if (existing) return NextResponse.json(toApiRun(existing), { status: 200 });
  }

  const record = {
    project: projectId,
    task: body.taskId,
    taskKey: body.taskKey.slice(0, MAX_NAME),
    worker: workerId,
    ...(runId ? { runId } : {}),
    agent: agentId,
    agentName: typeof body.agentName === "string" ? body.agentName.slice(0, MAX_NAME) : "",
    outcome,
    refusedBy: typeof body.refusedBy === "string" ? body.refusedBy.slice(0, MAX_DETAIL) : "",
    detail,
    startedAt: notAfterNow(body.startedAt),
    finishedAt: notAfterNow(body.finishedAt),
    costUsd: typeof body.costUsd === "number" && body.costUsd >= 0 ? body.costUsd : 0,
  };

  try {
    const run = await AgentRun.create(record);
    return NextResponse.json(toApiRun(run.toObject()), { status: 201 });
  } catch (error) {
    const duplicate = (error as { code?: number }).code === 11000;
    const existing = duplicate && runId ? await recorded() : null;
    if (!existing) throw error;
    return NextResponse.json(toApiRun(existing), { status: 200 });
  }
}, { reach: "runRecord" });
