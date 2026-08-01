import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf, resolveProjectId, withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { verdictFor } from "@/lib/worker-service";

export const POST = withWorker(async (request, { params, worker }) => {
  const { projectId: identifier } = await params;
  await connectDB();

  const projectId = await resolveProjectId(identifier);
  if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Before the verdict on purpose: locking the only worker of a project must not also stop the
  // queue from healing tasks its previous run abandoned
  await releaseExpiredTasks(projectId).catch(() => 0);

  const verdict = verdictFor(worker, projectId, protocolOf(request));
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 403 });

  const { runId } = await request.json().catch(() => ({}));
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const task = await claimNextTask(projectId, String(worker._id), runId);
  if (!task) return new NextResponse(null, { status: 204 });

  return NextResponse.json(task);
});
