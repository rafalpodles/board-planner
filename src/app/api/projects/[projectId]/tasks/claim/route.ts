import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf, resolveProjectId, withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { ownerReachableProjectIds, verdictFor } from "@/lib/worker-service";
import { snapshotFor } from "@/lib/agent-snapshot";
import { releaseTask } from "@/lib/task-service";

export const POST = withWorker(async (request, { params, worker }) => {
  const { projectId: identifier } = await params;
  await connectDB();

  const projectId = await resolveProjectId(identifier);
  if (!projectId) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Before the verdict on purpose: locking the only worker of a project must not also stop the
  // queue from healing tasks its previous run abandoned
  await releaseExpiredTasks(projectId).catch(() => 0);

  const [project, others, reachable] = await Promise.all([
    Project.findById(projectId).select("_id repositoryUrl githubRepo gitlabRepo gitlabHost worker").lean(),
    // A worker that lost a contested checkout must be refused here too, not merely left unassigned
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

  const task = await claimNextTask(
    projectId,
    String(worker._id),
    runId,
    worker.owner ? String(worker.owner) : null
  );
  if (!task) return new NextResponse(null, { status: 204 });

  // Resolved here rather than referenced, so the run means what it meant when it started even if
  // the agent is edited while it holds the task.
  const agent = await snapshotFor(projectId, task.agent);
  if (!agent) {
    // Holding a task a machine cannot run would park it behind a lease for two hours. Hand it back
    // at once and say why, so the board shows the cause rather than a silent stall.
    await releaseTask(projectId, String(task._id), { refund: true }).catch(() => {});
    // 204, not an error: the worker's loop treats a failed claim as a cycle failure and retries on
    // the next poll, so an unrunnable default would claim and release every thirty seconds forever.
    // Nothing is claimable here until somebody fixes the project, which is what 204 means.
    return new NextResponse(null, { status: 204 });
  }

  // toJSON, not a spread: claimNextTask returns a hydrated document, and spreading one yields
  // `$__`, `$isNew` and `_doc` — every real field one level down, where the worker never looks. It
  // read taskNumber as undefined, refused the key "BP-undefined", and left the task held for the
  // full lease. This route used to hand the document straight to NextResponse.json, which called
  // toJSON itself; adding a field alongside it is what removed that.
  return NextResponse.json({ ...task.toJSON(), agent });
});
