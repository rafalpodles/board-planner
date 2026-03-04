import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { User } from "@/models/user";
import { logActivity } from "@/lib/activity";
import { parseChecklistString } from "@/lib/checklist";
import { createNotifications, collectRecipients } from "@/lib/in-app-notifications";
import { Project } from "@/models/project";

const populateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
];

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId })
    .populate(populateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Find tasks that this task is blocking (reverse lookup)
  const blocking = await Task.find(
    { blockedBy: taskId, project: projectId },
    "taskNumber title status"
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskObj: any = task.toObject();
  taskObj.blocking = blocking;

  return NextResponse.json(taskObj);
});

export const PUT = withProjectAccess(async (request, { params, user }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const body = await request.json();

  // Whitelist allowed fields to prevent overwriting protected fields
  const allowed = [
    "title", "description", "difficulty", "component", "category",
    "status", "assignee", "dueDate", "checklist", "labels", "order", "pinned", "sprint", "recurrence",
  ];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  // Support acceptanceCriteria string input (from AI/MCP) — convert to checklist
  if (body.acceptanceCriteria !== undefined && updates.checklist === undefined) {
    const acText = Array.isArray(body.acceptanceCriteria)
      ? body.acceptanceCriteria.join("\n")
      : body.acceptanceCriteria;
    updates.checklist = parseChecklistString(acText);
  }

  // Read old values before updating for activity log
  const oldTask = await Task.findOne({ _id: taskId, project: projectId })
    .populate("assignee", "username fullName")
    .lean();
  if (!oldTask) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Resolve assignee username to ObjectId if provided as string
  if (updates.assignee && typeof updates.assignee === "string") {
    const assigneeUser = await User.findOne({
      username: (updates.assignee as string).toLowerCase(),
    });
    updates.assignee = assigneeUser ? assigneeUser._id : null;
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: updates },
    { new: true, runValidators: true }
  ).populate(populateFields);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Log field changes (parallel)
  const activities: Promise<void>[] = [];
  const trackFields = ["title", "difficulty", "component", "category", "status"];
  for (const field of trackFields) {
    const oldVal = String(oldTask[field as keyof typeof oldTask] ?? "");
    const newVal = String(task[field as keyof typeof task] ?? "");
    if (oldVal !== newVal) {
      const action = field === "status" ? "status_changed" as const : "updated" as const;
      activities.push(logActivity(taskId, user._id, action, field, oldVal, newVal));
    }
  }

  // Log assignee change
  if (updates.assignee !== undefined) {
    const oldAssignee = oldTask.assignee && typeof oldTask.assignee === "object"
      ? (oldTask.assignee as { username: string }).username
      : "";
    const newAssignee = task.assignee && typeof task.assignee === "object"
      ? (task.assignee as { username: string }).username
      : "";
    if (oldAssignee !== newAssignee) {
      activities.push(logActivity(taskId, user._id, "updated", "assignee", oldAssignee, newAssignee));
    }
  }

  // Auto-watch on assign
  if (updates.assignee && task.assignee) {
    const assigneeId = typeof task.assignee === "object" && "_id" in task.assignee
      ? task.assignee._id
      : task.assignee;
    if (assigneeId) {
      activities.push(
        Task.findByIdAndUpdate(taskId, { $addToSet: { watchers: assigneeId } }).then(() => {})
      );
    }
  }

  await Promise.all(activities);

  // In-app notification: assignee changed
  if (updates.assignee !== undefined && task.assignee) {
    const newAssigneeId = typeof task.assignee === "object" && "_id" in task.assignee
      ? String(task.assignee._id)
      : String(task.assignee);
    const project = await Project.findById(projectId, "key").lean();
    const taskKey = project ? `${project.key}-${task.taskNumber}` : `#${task.taskNumber}`;
    createNotifications({
      type: "task_assigned",
      taskId,
      projectId,
      actorId: String(user._id),
      title: `${taskKey} assigned to you`,
      body: task.title,
      recipientIds: [newAssigneeId],
    });
  }

  return NextResponse.json(task);
});

export const DELETE = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const task = await Task.findOneAndDelete({
    _id: taskId,
    project: projectId,
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Delete associated comments and activity logs
  await Promise.all([
    Comment.deleteMany({ task: taskId }),
    ActivityLog.deleteMany({ task: taskId }),
  ]);

  return NextResponse.json({ message: "Task deleted" });
});
