import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { machineMayNotForce, MACHINE_FORCE_REFUSAL } from "@/lib/force-guard";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { Notification } from "@/models/notification";
import { toApiExecution, updateTask, taskPopulateFields, heldRunRefusal } from "@/lib/task-service";
import { Project } from "@/models/project";
import { Worker } from "@/models/worker";
import { ITaskExecution } from "@/types";


export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId })
    .populate(taskPopulateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Reverse lookups: who points at this task
  const [blocking, incoming] = await Promise.all([
    Task.find({ blockedBy: taskId, project: projectId }, "taskNumber title status"),
    Task.find(
      { "relations.task": taskId, project: projectId },
      "taskNumber title status relations"
    ),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskObj: any = task.toObject();
  taskObj.blocking = blocking;
  taskObj.relatedFrom = incoming.flatMap((t) =>
    (t.relations || [])
      .filter((r) => String(r.task) === String(taskId))
      .map((r) => ({
        type: r.type,
        task: { _id: t._id, taskNumber: t.taskNumber, title: t.title, status: t.status },
      }))
  );

  taskObj.execution = toApiExecution(task.execution, await workerNamesFor([task.execution]));

  return NextResponse.json(taskObj);
});


// Only runs still holding a task carry a workerId, so this reads a handful of documents at most —
// and skips the query entirely when nothing is running.
async function workerNamesFor(executions: (ITaskExecution | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(executions.filter((e) => e?.runId && e.workerId).map((e) => e!.workerId))];
  if (ids.length === 0) return new Map();
  const workers = await Worker.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(workers.map((w) => [String(w._id), w.name as string]));
}

export const PUT = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  const body = await request.json();

  // Kept out of the update itself: `force` is a instruction about the write, not a field on the task
  const { force, ...updates } = body ?? {};

  // The status route refuses this; this route reaches the identical code path and did not (BP-320)
  if (machineMayNotForce(user, force)) {
    return NextResponse.json({ error: MACHINE_FORCE_REFUSAL }, { status: 403 });
  }

  const result = await updateTask(projectId, taskId, updates, String(user._id), force === true);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.runConflict ? { runConflict: result.runConflict } : {}) },
      { status: result.status }
    );
  }

  return NextResponse.json(result.data);
});

export const DELETE = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  if (!isValidObjectId(taskId)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  await connectDB();

  // A delete carries no body unless the caller means to force, and `request.json()` throws on an
  // empty one — so an absent body is "do not force" rather than a 500.
  const body = (await request.json().catch(() => ({}))) as { force?: unknown };
  const force = body?.force;

  // Same rule as the PUT above and the status route: taking a task off a running machine needs a
  // person, and every MCP connection and API token is a machine credential (BP-320).
  if (machineMayNotForce(user, force)) {
    return NextResponse.json({ error: MACHINE_FORCE_REFUSAL }, { status: 403 });
  }

  // Read before deleting rather than deleting and asking: the run-hold check has to be able to
  // refuse, and findOneAndDelete has already done the thing by the time it can answer. This is the
  // fourth writer that takes a task out of a worker's hands and the only one that asked nothing —
  // and it reaches a strictly stronger outcome than the three that do, since the task is not moved
  // but gone, with the comments the run was writing into it (BP-337).
  const task = await Task.findOne({ _id: taskId, project: projectId })
    .select("execution taskNumber")
    .lean();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (force !== true) {
    const project = await Project.findById(projectId, "key").lean();
    const refusal = await heldRunRefusal(task, project?.key as string | undefined, "delete");
    if (refusal) {
      return NextResponse.json(
        { error: refusal.error, ...(refusal.runConflict ? { runConflict: refusal.runConflict } : {}) },
        { status: refusal.status }
      );
    }
  }

  await Task.deleteOne({ _id: taskId, project: projectId });

  await Promise.all([
    Comment.deleteMany({ task: taskId }),
    ActivityLog.deleteMany({ task: taskId }),
    Notification.deleteMany({ task: taskId }),
    Task.updateMany({ blockedBy: taskId }, { $pull: { blockedBy: taskId } }),
    Task.updateMany({ "relations.task": taskId }, { $pull: { relations: { task: taskId } } }),
  ]);

  return NextResponse.json({ message: "Task deleted" });
});
