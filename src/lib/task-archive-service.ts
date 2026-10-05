import type { ScopedDb } from "@/lib/db-scope";
import { connectDB } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { heldRunRefusal, taskPopulateFields, UNSET_RUN, type TaskServiceResult } from "@/lib/task-service";
import type { ITask } from "@/types";

export async function archiveTask(
  db: ScopedDb,
  projectId: string,
  taskId: string,
  actorId: string,
  force = false
): Promise<TaskServiceResult> {
  await connectDB();

  const populated = () => db.Task.findOne({ _id: taskId, project: projectId }).populate(taskPopulateFields);

  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await db.Task.findOne({ _id: taskId, project: projectId })
      .select("execution taskNumber archivedAt")
      .lean();
    if (!current) return { ok: false, error: "Task not found", status: 404 };
    if (current.archivedAt) return { ok: true, data: (await populated()) as ITask };

    const held = !!current.execution?.runId;
    if (held && !force) {
      const project = await db.Project.findById(projectId, "key").lean();
      const refusal = await heldRunRefusal(db, current, project?.key as string | undefined, "archive");
      if (refusal) return refusal;
    }

    const releasesWorker = held && current.execution?.assignedByRun !== false;
    const archived = await db.Task.findOneAndUpdate(
      {
        _id: taskId,
        project: projectId,
        archivedAt: null,
        ...(force ? {} : { "execution.runId": { $in: ["", null] } }),
      },
      {
        $set: {
          archivedAt: new Date(),
          archivedBy: actorId,
          ...(force && releasesWorker ? { assignee: null, assignedBy: null } : {}),
        },
        ...(force ? { $unset: { ...UNSET_RUN, "execution.startedAt": "" } } : {}),
      },
      { returnDocument: "after" }
    ).populate(taskPopulateFields);

    if (archived) {
      await logActivity(db, taskId, actorId, "archived");
      return { ok: true, data: archived as ITask };
    }
  }

  return { ok: false, error: "The task changed while it was being archived, try again", status: 409 };
}

export async function unarchiveTask(
  db: ScopedDb,
  projectId: string,
  taskId: string,
  actorId: string
): Promise<TaskServiceResult> {
  await connectDB();

  const restored = await db.Task.findOneAndUpdate(
    { _id: taskId, project: projectId, archivedAt: { $ne: null } },
    { $set: { archivedAt: null, archivedBy: null } },
    { returnDocument: "after" }
  ).populate(taskPopulateFields);

  if (restored) {
    await logActivity(db, taskId, actorId, "unarchived");
    return { ok: true, data: restored as ITask };
  }

  const task = await db.Task.findOne({ _id: taskId, project: projectId }).populate(taskPopulateFields);
  return task ? { ok: true, data: task as ITask } : { ok: false, error: "Task not found", status: 404 };
}
