import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { AgentRun } from "@/models/agentRun";
import { toFleetRun } from "@/lib/agent-service";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = withAdmin(async (request, { user }) => {
  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive admin session required" }, { status: 403 });
  }

  await connectDB();

  const asked = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;

  const runs = await AgentRun.find({})
    .sort({ finishedAt: -1 })
    .limit(limit)
    .populate("project", "key name")
    .populate("worker", "name")
    .lean();

  return NextResponse.json(runs.map((run) => toFleetRun(run as never)));
});
