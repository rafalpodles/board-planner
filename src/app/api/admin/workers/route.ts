import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Worker } from "@/models/worker";
import { Task } from "@/models/task";
import { toApiWorker } from "@/lib/worker-service";
import { ApiWorkerTask } from "@/types";

async function currentTasks(workerIds: string[]): Promise<Map<string, ApiWorkerTask>> {
  if (workerIds.length === 0) return new Map();

  const tasks = await Task.find({
    "execution.workerId": { $in: workerIds },
    "execution.runId": { $nin: [null, ""] },
  })
    .sort({ "execution.startedAt": -1 })
    .select("_id taskNumber title project execution")
    .populate("project", "key")
    .lean();

  const byWorker = new Map<string, ApiWorkerTask>();
  for (const task of tasks) {
    const workerId = task.execution?.workerId ?? "";
    if (!workerId || byWorker.has(workerId)) continue;

    const project = task.project as unknown as { key?: string } | undefined;
    byWorker.set(workerId, {
      taskId: String(task._id),
      taskKey: `${project?.key ?? "?"}-${task.taskNumber}`,
      title: task.title,
      ...(task.execution?.phase ? { phase: task.execution.phase } : {}),
      phaseAt: task.execution?.phaseAt ? new Date(task.execution.phaseAt).toISOString() : null,
    });
  }
  return byWorker;
}

export const GET = withAdmin(async () => {
  await connectDB();

  const workers = await Worker.find()
    .populate("owner", "username fullName")
    .sort({ name: 1, host: 1 });
  const now = new Date();
  const running = await currentTasks(workers.map((worker) => String(worker._id)));

  return NextResponse.json(
    workers.map((worker) => toApiWorker(worker, now, running.get(String(worker._id))))
  );
});
