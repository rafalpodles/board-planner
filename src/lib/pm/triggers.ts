import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { PmTrigger } from "@/models/pmTrigger";
import { getPmUser } from "./pm-user";

export async function enqueuePmTrigger(
  projectId: string,
  taskId: string,
  taskKey: string
): Promise<void> {
  try {
    await PmTrigger.create({
      project: projectId,
      type: "needs_human_review",
      taskKey,
      task: taskId,
      state: "pending",
    });
  } catch (err) {
    // Duplicate key = a trigger for this task is already queued or running
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export async function onTaskStatusChanged(args: {
  projectId: string;
  taskId: string;
  oldStatus: string;
  newStatus: string;
  actorId: string;
}): Promise<void> {
  if (args.newStatus !== "needs_human_review" || args.oldStatus === "needs_human_review") return;

  const project = await Project.findById(args.projectId, "key pm").lean();
  if (!project?.pm?.enabled || !project.pm.autonomy?.handleNeedsHumanReview) return;

  const pmUser = await getPmUser();
  if (String(pmUser._id) === args.actorId) return;

  const task = await Task.findById(args.taskId, "taskNumber").lean();
  if (!task) return;

  await enqueuePmTrigger(args.projectId, args.taskId, `${project.key}-${task.taskNumber}`);
}
