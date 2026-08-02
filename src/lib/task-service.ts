import { connectDB } from "@/lib/db";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Comment } from "@/models/comment";
import { ITask, DEFAULT_PRIORITY } from "@/types";
import { getColumnIds, defaultStatusFor, roleOf, getProjectColumns } from "@/lib/columns";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients, resolveMentions } from "@/lib/in-app-notifications";
import { parseChecklistString } from "@/lib/checklist";
import { validateCustomFieldValues, sanitizeCustomFieldValues } from "@/lib/custom-fields";
import { onTaskStatusChanged } from "@/lib/pm/triggers";

export const MAX_EXECUTION_ATTEMPTS = 3;

// Long enough for "gates:build" or "Edit src/lib/task-service.ts", short enough that a badge
// cannot become a payload
export const MAX_PHASE_LENGTH = 120;

const PHASE_FIELDS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
const UNSET_PHASE = Object.fromEntries(PHASE_FIELDS.map((field) => [field, ""]));

// Four times the worker's default task timeout. A worker killed mid-run leaves its task in the
// active column, where claimNextTask can never see it again — nothing else reclaims it.
export const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;

export const taskPopulateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "blockedBy", select: "taskNumber title status" },
  { path: "relations.task", select: "taskNumber title status" },
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
    { returnDocument: "after" }
  );

  if (!project) {
    return { ok: false, error: "Project not found", status: 404 };
  }

  const categoryNames = (project.categories || []).map((c) => c.name);
  const category =
    body.category ??
    (categoryNames.includes("user-story") ? "user-story" : categoryNames[0] ?? "user-story");
  if (categoryNames.length > 0 && !categoryNames.includes(category)) {
    return {
      ok: false,
      error: `Invalid category "${category}" — project categories: ${categoryNames.join(", ")}`,
      status: 400,
    };
  }

  const columnIds = getColumnIds(project);
  const status = body.status ?? defaultStatusFor(project);
  if (!columnIds.includes(status)) {
    return {
      ok: false,
      error: `Invalid status "${status}" — project columns: ${columnIds.join(", ")}`,
      status: 400,
    };
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
    priority: body.priority ?? DEFAULT_PRIORITY,
    component: body.component ?? "",
    category,
    status,
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

  const projectColumns = await Project.findById(projectId, "columns").lean();
  const columnIds = getColumnIds(projectColumns);
  if (!columnIds.includes(status)) {
    return {
      ok: false,
      error: `Invalid status. Must be one of: ${columnIds.join(", ")}`,
      status: 400,
    };
  }

  const oldTask = await Task.findOne({ _id: taskId, project: projectId }).lean();
  if (!oldTask) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    { $set: { status }, $unset: UNSET_PHASE },
    { returnDocument: "after" }
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

    if (roleOf(projectColumns, status) === "done" && oldTask.recurrence) {
      createNextRecurrence(oldTask, projectId, actorId).catch((err) =>
        console.error("Failed to create recurring task:", err)
      );
    }

    onTaskStatusChanged({
      projectId,
      taskId,
      oldStatus: oldTask.status,
      newStatus: status,
      actorId,
    }).catch((err) => console.error("PM status trigger failed:", err));
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
    "title", "description", "difficulty", "priority", "component", "category",
    "status", "assignee", "dueDate", "checklist", "labels", "order", "pinned", "sprint", "customFieldValues", "recurrence",
  ];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (updates.category !== undefined || updates.status !== undefined) {
    const proj = await Project.findById(projectId, "categories columns").lean();
    if (updates.category !== undefined) {
      const names = (proj?.categories || []).map((c) => c.name);
      if (names.length > 0 && !names.includes(String(updates.category))) {
        return {
          ok: false,
          error: `Invalid category "${updates.category}" — project categories: ${names.join(", ")}`,
          status: 400,
        };
      }
    }
    if (updates.status !== undefined) {
      const columnIds = getColumnIds(proj);
      if (!columnIds.includes(String(updates.status))) {
        return {
          ok: false,
          error: `Invalid status "${updates.status}" — project columns: ${columnIds.join(", ")}`,
          status: 400,
        };
      }
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

  // The edit form PUTs the whole task, status included, so this is as much an exit from the
  // active column as changeStatus is — but only when the status is actually part of the edit
  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    updates.status === undefined ? { $set: updates } : { $set: updates, $unset: UNSET_PHASE },
    { returnDocument: "after", runValidators: true }
  ).populate(taskPopulateFields);

  if (!task) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  // Log field changes (parallel)
  const activities: Promise<void>[] = [];
  const trackFields = ["title", "difficulty", "priority", "component", "category", "status"];
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

  // The edit form sends status inside the PUT body, so this path needs the hook too
  if (updates.status !== undefined && oldTask.status !== task.status) {
    onTaskStatusChanged({
      projectId,
      taskId,
      oldStatus: oldTask.status,
      newStatus: task.status,
      actorId,
    }).catch((err) => console.error("PM status trigger failed:", err));
  }

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function addComment(
  projectId: string,
  taskId: string,
  bodyText: string,
  actor: { id: string; username: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<TaskServiceResult<any>> {
  await connectDB();

  const task = await Task.findOne({ _id: taskId, project: projectId });
  if (!task) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  if (!bodyText || typeof bodyText !== "string" || !bodyText.trim()) {
    return { ok: false, error: "Comment body is required", status: 400 };
  }

  const comment = await Comment.create({
    task: taskId,
    author: actor.id,
    body: bodyText.trim(),
  });

  const populated = await Comment.findById(comment._id).populate({
    path: "author",
    select: "username fullName",
  });

  await Promise.all([
    logActivity(taskId, actor.id, "comment_added"),
    // Auto-watch task on comment
    Task.findByIdAndUpdate(taskId, { $addToSet: { watchers: actor.id } }),
  ]);

  const eventPayload = {
    project: { key: "", name: "" },
    task: {
      taskKey: `${task.taskNumber}`,
      title: task.title,
      status: task.status,
    },
    data: { commentBody: bodyText.trim().substring(0, 200), author: actor.username },
  };
  dispatchWebhooks(projectId, "comment_added", eventPayload);
  dispatchNotifications(projectId, "comment_added", eventPayload);

  const project = await Project.findById(projectId, "key").lean();
  const taskKey = project ? `${project.key}-${task.taskNumber}` : `#${task.taskNumber}`;
  const recipients = collectRecipients(task);
  createNotifications({
    type: "comment_added",
    taskId,
    projectId,
    actorId: actor.id,
    title: `New comment on ${taskKey}`,
    body: bodyText.trim().substring(0, 120),
    recipientIds: recipients,
  });

  const mentionedIds = await resolveMentions(bodyText);
  if (mentionedIds.length > 0) {
    createNotifications({
      type: "mentioned",
      taskId,
      projectId,
      actorId: actor.id,
      title: `You were mentioned in ${taskKey}`,
      body: bodyText.trim().substring(0, 120),
      recipientIds: mentionedIds,
    });
  }

  return { ok: true, data: populated };
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
    { returnDocument: "after" }
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
    priority: oldTask.priority || DEFAULT_PRIORITY,
    component: oldTask.component || "",
    category: oldTask.category || "user-story",
    status: defaultStatusFor(project),
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

export async function releaseExpiredTasks(projectId: string, now = new Date()): Promise<number> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  const approved = columns.find((c) => c.role === "approved")?.id;
  const active = columns.filter((c) => c.role === "active").map((c) => c.id);
  if (!approved || active.length === 0) return 0;

  const review = columns.filter((c) => c.role === "review");
  const exhausted = (review.find((c) => c.triggersPmReview) ?? review[0])?.id ?? approved;
  const expired = {
    project: projectId,
    status: { $in: active },
    "execution.startedAt": { $lt: new Date(now.getTime() - EXECUTION_LEASE_MS) },
  };

  // The attempt is not refunded: a task that repeatedly outlives its worker has to run out of
  // attempts and reach a human, rather than cycling through the queue forever
  const [spent, retryable] = await Promise.all([
    Task.updateMany(
      { ...expired, "execution.attempts": { $gte: MAX_EXECUTION_ATTEMPTS } },
      { $set: { status: exhausted }, $unset: UNSET_PHASE }
    ),
    Task.updateMany(
      { ...expired, "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      { $set: { status: approved }, $unset: UNSET_PHASE }
    ),
  ]);

  return spent.modifiedCount + retryable.modifiedCount;
}

export async function claimNextTask(
  projectId: string,
  workerId: string,
  runId: string
): Promise<ITask | null> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  const approved = columns.filter((c) => c.role === "approved").map((c) => c.id);
  const activeStatus = columns.find((c) => c.role === "active")?.id;
  if (approved.length === 0 || !activeStatus) return null;

  return Task.findOneAndUpdate(
    {
      project: projectId,
      status: { $in: approved },
      // Mongoose applies defaults at hydration, so tasks created before the
      // execution subdocument existed have no such field — and $lt never
      // matches a missing one
      $or: [
        { "execution.attempts": { $exists: false } },
        { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      ],
    },
    {
      $set: {
        status: activeStatus,
        "execution.workerId": workerId,
        "execution.runId": runId,
        "execution.startedAt": new Date(),
        "execution.lastError": "",
      },
      // A run counts its own phases from one, so a phaseSeq left by an earlier run would swallow
      // the first events of this one
      $unset: UNSET_PHASE,
      $inc: { "execution.attempts": 1 },
    },
    { returnDocument: "after", sort: { order: 1, createdAt: 1 } }
  );
}

export async function releaseTask(
  projectId: string,
  taskId: string,
  options: { refund?: boolean } = {}
): Promise<ITask | null> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  const approved = columns.find((c) => c.role === "approved")?.id;
  const active = columns.filter((c) => c.role === "active").map((c) => c.id);
  if (!approved || active.length === 0) return null;

  if (options.refund === false) {
    const review = columns.filter((c) => c.role === "review");
    const exhausted = (review.find((c) => c.triggersPmReview) ?? review[0])?.id ?? approved;

    return Task.findOneAndUpdate(
      { _id: taskId, project: projectId, status: { $in: active } },
      [
        {
          $set: {
            status: {
              $cond: [
                { $gte: ["$execution.attempts", MAX_EXECUTION_ATTEMPTS] },
                exhausted,
                approved,
              ],
            },
          },
        },
        { $unset: PHASE_FIELDS },
      ],
      { returnDocument: "after", updatePipeline: true }
    );
  }

  return Task.findOneAndUpdate(
    {
      _id: taskId,
      project: projectId,
      status: { $in: active },
      "execution.attempts": { $gt: 0 },
    },
    { $set: { status: approved }, $inc: { "execution.attempts": -1 }, $unset: UNSET_PHASE },
    { returnDocument: "after" }
  );
}

export interface TaskPhaseUpdate {
  taskId: string;
  workerId: string;
  runId: string;
  seq: number;
  phase: string;
}

// A phase is a short label for a board badge, and the only free text a worker can write onto a
// task without going through a comment. Anything longer, empty, or carrying control characters is
// not a label.
export function phaseFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phase = value.trim();
  if (!phase || phase.length > MAX_PHASE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(phase)) return null;
  return phase;
}

// The run is the authorization: a worker that has been released from this task, or whose run was
// superseded by a newer claim, matches nothing however valid its credential is.
export async function recordTaskPhase(event: TaskPhaseUpdate): Promise<boolean> {
  await connectDB();

  const result = await Task.updateOne(
    {
      _id: event.taskId,
      "execution.workerId": event.workerId,
      "execution.runId": event.runId,
      // Same trap as claimNextTask's attempts guard: a task that has never carried a phase has no
      // phaseSeq at all, and $lt never matches a missing field
      $or: [
        { "execution.phaseSeq": { $exists: false } },
        { "execution.phaseSeq": { $lt: event.seq } },
      ],
    },
    {
      $set: {
        "execution.phase": event.phase,
        "execution.phaseAt": new Date(),
        "execution.phaseSeq": event.seq,
      },
    }
  );

  return result.matchedCount > 0;
}
