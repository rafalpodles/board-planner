import { connectDB } from "@/lib/db";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { ITask, TASK_STATUSES, TaskStatus } from "@/types";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients } from "@/lib/in-app-notifications";
import { parseChecklistString } from "@/lib/checklist";
import { validateCustomFieldValues, sanitizeCustomFieldValues } from "@/lib/custom-fields";

export const taskPopulateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
];

export type TaskServiceResult<T = ITask> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

export async function createTask(
  projectId: string,
  actorId: string,
  body: Body
): Promise<TaskServiceResult> {
  await connectDB();

  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { new: true }
  );

  if (!project) {
    return { ok: false, error: "Project not found", status: 404 };
  }

  let assigneeId = null;
  if (body.assignee) {
    const assigneeUser = await User.findOne({
      username: String(body.assignee).toLowerCase(),
    });
    if (assigneeUser) {
      assigneeId = assigneeUser._id;
    }
  }

  const task = await Task.create({
    project: projectId,
    taskNumber: project.taskCounter,
    title: body.title,
    description: body.description ?? "",
    difficulty: body.difficulty ?? "M",
    component: body.component ?? "",
    category: body.category ?? "user-story",
    status: body.status ?? "planned",
    assignee: assigneeId,
    dueDate: body.dueDate || null,
    checklist: Array.isArray(body.checklist)
      ? body.checklist
      : parseChecklistString(
          Array.isArray(body.acceptanceCriteria)
            ? body.acceptanceCriteria.join("\n")
            : (body.acceptanceCriteria ?? "")
        ),
    labels: Array.isArray(body.labels) ? body.labels : [],
    sprint: body.sprint || null,
    customFieldValues: (() => {
      const raw = body.customFieldValues || {};
      if (typeof raw !== "object" || Array.isArray(raw)) return {};
      const defs = project.customFields || [];
      const sanitized = sanitizeCustomFieldValues(raw, defs);
      const result = validateCustomFieldValues(sanitized, defs);
      return result.valid ? sanitized : {};
    })(),
    recurrence: body.recurrence || null,
    order: body.order ?? 0,
    createdBy: actorId,
  });

  const populated = await Task.findById(task._id).populate(taskPopulateFields);

  await logActivity(String(task._id), actorId, "created");

  const eventPayload = {
    project: { key: project.key, name: project.name },
    task: {
      taskKey: `${project.key}-${task.taskNumber}`,
      title: task.title,
      status: task.status,
    },
  };
  dispatchWebhooks(projectId, "task_created", eventPayload);
  dispatchNotifications(projectId, "task_created", eventPayload);

  return { ok: true, data: populated as ITask };
}

export async function changeStatus(
  projectId: string,
  taskId: string,
  status: string,
  actorId: string
): Promise<TaskServiceResult> {
  await connectDB();

  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    return {
      ok: false,
      error: `Invalid status. Must be one of: ${TASK_STATUSES.join(", ")}`,
      status: 400,
    };
  }

  const oldTask = await Task.findOne({ _id: taskId, project: projectId }).lean();
  if (!oldTask) {
    return { ok: false, error: "Task not found", status: 404 };
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
    return { ok: false, error: "Task not found", status: 404 };
  }

  if (oldTask.status !== status) {
    await logActivity(taskId, actorId, "status_changed", "status", oldTask.status, status);

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

    const project = await Project.findById(projectId, "key name").lean();
    const taskKey = project ? `${project.key}-${task.taskNumber}` : `#${task.taskNumber}`;
    const recipients = collectRecipients(task);
    createNotifications({
      type: "status_changed",
      taskId,
      projectId,
      actorId,
      title: `${taskKey} → ${status}`,
      body: task.title,
      recipientIds: recipients,
    });

    if (status === "done" && oldTask.recurrence) {
      createNextRecurrence(oldTask, projectId, actorId).catch((err) =>
        console.error("Failed to create recurring task:", err)
      );
    }
  }

  return { ok: true, data: task as ITask };
}

export async function updateTask(
  projectId: string,
  taskId: string,
  body: Body,
  actorId: string
): Promise<TaskServiceResult> {
  await connectDB();

  // Whitelist allowed fields to prevent overwriting protected fields
  const allowed = [
    "title", "description", "difficulty", "component", "category",
    "status", "assignee", "dueDate", "checklist", "labels", "order", "pinned", "sprint", "customFieldValues", "recurrence",
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

  if (updates.customFieldValues !== undefined) {
    const raw = updates.customFieldValues;
    if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
      updates.customFieldValues = {};
    } else {
      const project = await Project.findById(projectId, "customFields").lean();
      const defs = project?.customFields || [];
      const sanitized = sanitizeCustomFieldValues(raw as Record<string, unknown>, defs);
      const result = validateCustomFieldValues(sanitized, defs);
      if (!result.valid) {
        return { ok: false, error: result.error ?? "Invalid custom field values", status: 400 };
      }
      updates.customFieldValues = sanitized;
    }
  }

  const oldTask = await Task.findOne({ _id: taskId, project: projectId })
    .populate("assignee", "username fullName")
    .lean();
  if (!oldTask) {
    return { ok: false, error: "Task not found", status: 404 };
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
  ).populate(taskPopulateFields);

  if (!task) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  // Log field changes (parallel)
  const activities: Promise<void>[] = [];
  const trackFields = ["title", "difficulty", "component", "category", "status"];
  for (const field of trackFields) {
    const oldVal = String(oldTask[field as keyof typeof oldTask] ?? "");
    const newVal = String(task[field as keyof typeof task] ?? "");
    if (oldVal !== newVal) {
      const action = field === "status" ? "status_changed" as const : "updated" as const;
      activities.push(logActivity(taskId, actorId, action, field, oldVal, newVal));
    }
  }

  if (updates.assignee !== undefined) {
    const oldAssignee = oldTask.assignee && typeof oldTask.assignee === "object"
      ? (oldTask.assignee as { username: string }).username
      : "";
    const newAssignee = task.assignee && typeof task.assignee === "object"
      ? (task.assignee as { username: string }).username
      : "";
    if (oldAssignee !== newAssignee) {
      activities.push(logActivity(taskId, actorId, "updated", "assignee", oldAssignee, newAssignee));
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
      actorId,
      title: `${taskKey} assigned to you`,
      body: task.title,
      recipientIds: [newAssigneeId],
    });
  }

  return { ok: true, data: task as ITask };
}

export async function assignTask(
  projectId: string,
  taskId: string,
  username: string | null,
  actorId: string
): Promise<TaskServiceResult> {
  return updateTask(projectId, taskId, { assignee: username }, actorId);
}

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
