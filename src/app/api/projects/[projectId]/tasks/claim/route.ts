import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf, resolveProjectId, withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { BoardCannotClaim } from "@/lib/claim-refusal";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { ownerReachableProjectIds, verdictFor } from "@/lib/worker-service";
import { snapshotFor } from "@/lib/agent-snapshot";
import { releaseTask } from "@/lib/task-service";

function ownerIdOf(owner: unknown): string | null {
  if (!owner) return null;
  const ref = owner as { _id?: unknown };
  return String(ref._id ?? owner);
}

export const POST = withWorker(async (request, { params, worker }) => {
  const { projectId: identifier } = await params;
  await connectDB();

  const projectId = await resolveProjectId(identifier);
  if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await releaseExpiredTasks(projectId).catch(() => 0);

  const [project, others, reachable] = await Promise.all([
    Project.findById(projectId).select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    Worker.find({ _id: { $ne: worker._id } }).select(
      "_id name host repos enabled lockedByInstance lastSeenAt createdAt"
    ),
    ownerReachableProjectIds(worker),
  ]);
  const verdict = verdictFor(
    worker,
    project as never,
    protocolOf(request),
    new Date(),
    others as never,
    reachable
  );
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 403 });

  const { runId } = (await request.json().catch(() => ({}))) ?? {};
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    return NextResponse.json(
      { error: "runId must be 1-64 characters of letters, digits, hyphen or underscore" },
      { status: 400 }
    );
  }

  const machineOwnerId = ownerIdOf(worker.owner);

  let task: Awaited<ReturnType<typeof claimNextTask>>;
  try {
    task = await claimNextTask(projectId, String(worker._id), runId, machineOwnerId);
  } catch (error) {
    if (error instanceof BoardCannotClaim) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  if (!task) return new NextResponse(null, { status: 204 });

  const agent = await snapshotFor(projectId, task.agent, machineOwnerId);
  if (!agent) {
    await releaseTask(projectId, String(task._id), {
      refund: false,
      workerId: String(worker._id),
    }).catch(() => {});
    console.error(
      `Claim released: ${projectId}/${String(task._id)} names agent ${String(task.agent)}, which resolves to nothing runnable`
    );
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({ ...task.toJSON(), agent });
});
