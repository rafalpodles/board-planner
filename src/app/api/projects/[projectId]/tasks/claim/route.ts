import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf, resolveProjectId, withWorker } from "@/lib/middleware";
import { claimNextTask, releaseExpiredTasks } from "@/lib/task-service";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { ownerReachableProjectIds, verdictFor } from "@/lib/worker-service";
import { snapshotFor } from "@/lib/agent-snapshot";
import { releaseTask } from "@/lib/task-service";

// The ref, never a populated document: `IWorker["owner"]` admits both since the fleet route
// populates it, and `String(<document>)` yields something that is not an id — which claimNextTask
// answers by claiming nothing, silently, for the whole fleet.
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

  const machineOwnerId = ownerIdOf(worker.owner);

  const task = await claimNextTask(projectId, String(worker._id), runId, machineOwnerId);
  if (!task) return new NextResponse(null, { status: 204 });

  // Resolved here rather than referenced, so the run means what it meant when it started even if
  // the agent is edited while it holds the task.
  //
  // The owner goes with it: a personal agent is a composition nobody vetted, and this is the last
  // point before it runs at which anyone can ask whether the machine about to run it is that
  // person's own.
  const agent = await snapshotFor(projectId, task.agent, machineOwnerId);
  if (!agent) {
    // Holding a task a machine cannot run would park it behind a lease for two hours. Hand it back
    // at once instead.
    //
    // Without the refund, deliberately. Refunding the attempt made this unbounded: the task returns
    // to the head of the approved column, sorts first again on the next poll thirty seconds later,
    // and every other claimable task on the project waits behind it — for good, because attempts
    // never accumulate and nothing ever escalates. Spending the attempt bounds it at
    // MAX_EXECUTION_ATTEMPTS, after which releaseTask parks the task in the escalation column where
    // a person sees it.
    //
    // The everyday way in was an agent nobody had composed yet; task-service now refuses to write
    // one of those onto a task at all. This is what happens to the ones that are left: an agent
    // emptied or deleted after it was chosen, or one naming a block this instance does not have.
    await releaseTask(projectId, String(task._id), {
      refund: false,
      workerId: String(worker._id),
    }).catch(() => {});
    // Logged, because nothing else records it: the task moves back a column with no comment, no
    // activity row and no run to attach an error to.
    console.error(
      `Claim released: ${projectId}/${String(task._id)} names agent ${String(task.agent)}, which resolves to nothing runnable`
    );
    // 204, not an error: the worker's loop treats a failed claim as a cycle failure and retries on
    // the next poll. Nothing is claimable here until somebody fixes the agent, which is what 204
    // means.
    return new NextResponse(null, { status: 204 });
  }

  // toJSON, not a spread: claimNextTask returns a hydrated document, and spreading one yields
  // `$__`, `$isNew` and `_doc` — every real field one level down, where the worker never looks. It
  // read taskNumber as undefined, refused the key "BP-undefined", and left the task held for the
  // full lease. This route used to hand the document straight to NextResponse.json, which called
  // toJSON itself; adding a field alongside it is what removed that.
  return NextResponse.json({ ...task.toJSON(), agent });
});
