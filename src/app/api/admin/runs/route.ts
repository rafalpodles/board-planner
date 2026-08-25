import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { AgentRun } from "@/models/agentRun";
import { toFleetRun } from "@/lib/agent-service";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// What a run left behind, across every project on this instance. A project's own recent runs are
// read through /api/projects/[projectId]/runs by anyone who can reach that project; this one spans
// the fleet, so it is instance admin only, matching the console it feeds.
export const GET = withAdmin(async (request, { user }) => {
  // Parity with the instance audit read: an unscoped admin API token keeps role "admin", and one
  // sitting on a worker's disk is readable by the agent running there — which would hand it every
  // project's run detail rather than the one it works on.
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
