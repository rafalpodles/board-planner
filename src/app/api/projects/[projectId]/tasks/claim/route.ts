import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const { workerId, runId } = await request.json();
  if (typeof workerId !== "string" || !workerId.trim()) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  // The request that wants work is also the one that frees tasks abandoned by a dead worker,
  // so nothing else has to be running for the queue to heal
  await releaseExpiredTasks(projectId).catch(() => 0);

  const task = await claimNextTask(projectId, workerId, runId);
  if (!task) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json(task);
});
