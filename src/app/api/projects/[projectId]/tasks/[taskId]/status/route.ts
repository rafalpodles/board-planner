import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES, TaskStatus } from "@/types";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients } from "@/lib/in-app-notifications";
import { Project } from "@/models/project";

export const PATCH = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const { status } = await request.json();

  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${TASK_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const oldTask = await Task.findOne({ _id: taskId, project: projectId }).lean();
  if (!oldTask) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: { status } },
    { new: true }
  ).populate([
    { path: "assignee", select: "username fullName" },
    { path: "createdBy", select: "username fullName" },
  ]);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (oldTask.status !== status) {
    await logActivity(taskId, user._id, "status_changed", "status", oldTask.status, status);

    const eventPayload = {
      project: { key: "", name: "" },
      task: {
        taskKey: `${oldTask.taskNumber}`,
        title: task.title,
        status,
      },
      data: { oldStatus: oldTask.status, newStatus: status },
    };
    dispatchWebhooks(projectId, "status_changed", eventPayload);
    dispatchNotifications(projectId, "status_changed", eventPayload);

    // In-app notifications
    const project = await Project.findById(projectId, "key name").lean();
    const taskKey = project ? `${project.key}-${task.taskNumber}` : `#${task.taskNumber}`;
    const recipients = collectRecipients(task);
    createNotifications({
      type: "status_changed",
      taskId,
      projectId,
      actorId: String(user._id),
      title: `${taskKey} → ${status}`,
      body: task.title,
      recipientIds: recipients,
    });

    // Auto-create next recurring task when moved to done
    if (status === "done" && oldTask.recurrence) {
      createNextRecurrence(oldTask, projectId, String(user._id)).catch((err) =>
        console.error("Failed to create recurring task:", err)
      );
    }
  }

  return NextResponse.json(task);
});

async function createNextRecurrence(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldTask: any,
  projectId: string,
  userId: string
): Promise<void> {
  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { new: true }
  );
  if (!project) return;

  const { frequency, interval } = oldTask.recurrence;
  const baseDate = oldTask.dueDate ? new Date(oldTask.dueDate) : new Date();
  const nextDue = new Date(baseDate);

  switch (frequency) {
    case "daily":
      nextDue.setDate(nextDue.getDate() + interval);
      break;
    case "weekly":
      nextDue.setDate(nextDue.getDate() + 7 * interval);
      break;
    case "monthly":
      nextDue.setMonth(nextDue.getMonth() + interval);
      break;
  }

  // Reset checklist items to undone
  const checklist = (oldTask.checklist || []).map(
    (item: { text: string }) => ({ text: item.text, done: false })
  );

  await Task.create({
    project: projectId,
    taskNumber: project.taskCounter,
    title: oldTask.title,
    description: oldTask.description || "",
    difficulty: oldTask.difficulty || "M",
    component: oldTask.component || "",
    category: oldTask.category || "user-story",
    status: "planned",
    assignee: oldTask.assignee,
    dueDate: nextDue,
    checklist,
    labels: oldTask.labels || [],
    recurrence: oldTask.recurrence,
    recurringParentId: oldTask._id,
    order: 0,
    createdBy: userId,
  });

  await logActivity(
    String(oldTask._id),
    userId,
    "updated",
    "recurrence",
    "",
    `Next occurrence created: ${project.key}-${project.taskCounter}`
  );
}
