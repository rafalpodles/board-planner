import { HydratedDocument, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Comment } from "@/models/comment";
import { Worker } from "@/models/worker";
import { Sprint } from "@/models/sprint";
import {
  ApiTaskExecution,
  ICustomField,
  ITask,
  ITaskExecution,
  RunConflict,
  DEFAULT_PRIORITY,
  PRIORITIES,
} from "@/types";
import { getColumnIds, defaultStatusFor, roleOf, getProjectColumns, columnIdsWithRole } from "@/lib/columns";
import { BoardCannotClaim, ROLES_A_RUN_NEEDS } from "@/lib/claim-refusal";
import { escalationColumnId } from "@/lib/escalation";
import { isRunnable, normaliseComposition } from "@/lib/agent-rules";
import { taskKeyOf } from "@/lib/task-key";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import {
  createNotifications,
  collectRecipients,
  resolveMentions,
  assigneeIdOf,
} from "@/lib/in-app-notifications";
import { notifyBoardFeed } from "@/lib/board-feed";
import { pillToneForRole } from "@/lib/email-template";
import { parseChecklistString } from "@/lib/checklist";
import { undoneChecklist } from "@/lib/task-duplicate";
import {
  CRITERION_TEXT_RULE,
  TASK_TITLE_RULE,
  isValidCriterionText,
  isValidTaskTitle,
  rendersBlank,
} from "@/lib/identifiers";
import {
  validateCustomFieldValues,
  sanitizeCustomFieldValues,
  customFieldActivityChanges,
} from "@/lib/custom-fields";
import { normaliseRecurrence, nextOccurrence, keptAnchor } from "@/lib/recurrence";
import type { NormalisedRecurrence } from "@/lib/recurrence";
import { onTaskStatusChanged } from "@/lib/pm/triggers";
import { canBeAssigned } from "@/lib/grants";
import { workerUsername } from "@/lib/worker-user";
import { pmUserId } from "@/lib/pm/pm-user";

export const MAX_EXECUTION_ATTEMPTS = 3;

export const MAX_PHASE_LENGTH = 120;

const PHASE_FIELDS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
const RUN_FIELDS = [...PHASE_FIELDS, "execution.runId"];
const UNSET_RUN = Object.fromEntries(RUN_FIELDS.map((field) => [field, ""]));

const RUN_RELEASES_ASSIGNEE = {
  $and: [
    { $ne: [{ $ifNull: ["$execution.runId", ""] }, ""] },
    { $eq: [{ $ifNull: ["$execution.assignedByRun", true] }, true] },
  ],
};

export const CLEAR_WORKER_ASSIGNEE = {
  assignee: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignee"] },
  assignedBy: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignedBy"] },
};

const STILL_HELD = { "execution.runId": { $nin: ["", null] } };

export const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;

function noAccessToAssign(username?: string | null): string {
  const who = username ? `@${username}` : "That account";
  return `${who} has no access to this board, so the task cannot be assigned to them. A board owner can add them in the project's Members settings.`;
}

function noSuchAccount(username: unknown): string {
  return `No account named "@${String(username).slice(0, 64)}" — the assignee is a username, and the project's Members settings list the ones this board takes.`;
}

type ResolvedAssignee = { user: { _id: Types.ObjectId; username: string } };

async function resolveAssignee(value: unknown): Promise<ResolvedAssignee | TaskServiceResult> {
  if (typeof value !== "string") {
    return { ok: false, error: "The assignee must be a username", status: 400 };
  }
  const user = await User.findOne({ username: value.trim().toLowerCase() });
  if (!user) return { ok: false, error: noSuchAccount(value), status: 400 };
  return { user: user as unknown as ResolvedAssignee["user"] };
}

export const taskPopulateFields = [
  { path: "assignee", select: "username fullName" },
  { path: "assignedBy", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  { path: "agent", select: "name" },
  { path: "blockedBy", select: "taskNumber title status" },
  { path: "relations.task", select: "taskNumber title status" },
];

function refId(ref: unknown): string {
  return ref && typeof ref === "object" && "_id" in ref
    ? String((ref as { _id: unknown })._id)
    : String(ref ?? "");
}

export type TaskServiceResult<T = ITask> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; runConflict?: RunConflict };

export function runHolding(task: {
  execution?: { runId?: string; workerId?: string; phase?: string; phaseAt?: Date | null };
}): RunConflict | null {
  const execution = task.execution;
  if (!execution?.runId) return null;
  return {
    workerId: execution.workerId || "",
    phase: execution.phase || "starting",
    phaseAt: execution.phaseAt ? new Date(execution.phaseAt).toISOString() : null,
  };
}

export async function heldRunRefusal(
  task: { execution?: Parameters<typeof runHolding>[0]["execution"]; taskNumber: number },
  projectKey: string | null | undefined,
  action = "move"
): Promise<Extract<TaskServiceResult, { ok: false }> | null> {
  const conflict = runHolding(task);
  if (!conflict) return null;
  return refuseHeldRun(conflict, taskKeyOf(projectKey, task.taskNumber), action);
}

async function refuseHeldRun(
  conflict: RunConflict,
  taskKey: string,
  action = "move"
): Promise<Extract<TaskServiceResult, { ok: false }>> {
  const worker = conflict.workerId
    ? await Worker.findById(conflict.workerId, "name").lean()
    : null;
  const name = (worker?.name as string) || conflict.workerId || "a worker";
  return {
    ok: false,
    error: `${taskKey} is being executed by ${name} (phase ${conflict.phase}). Stop the worker, or ${action} it anyway to take the task from it.`,
    status: 409,
    runConflict: { ...conflict, ...(worker?.name ? { workerName: worker.name as string } : {}) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

async function agentUsableOnProject(
  projectId: string,
  agent: unknown,
  actingUserId: unknown,
  assigneeAfter: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const unusable = { ok: false as const, error: "That agent cannot run on this project" };
  if (typeof agent !== "string" || !Types.ObjectId.isValid(agent)) return unusable;
  const { Agent } = await import("@/models/agent");
  const found = await Agent.findById(agent, "scope project owner name composition").lean();
  if (!found) return unusable;
  if (found.scope === "project" && String(found.project) !== String(projectId)) return unusable;
  if (found.scope === "user" && String(found.owner) !== String(actingUserId)) return unusable;
  if (found.scope === "user" && String(found.owner) !== String(assigneeAfter ?? "")) {
    return {
      ok: false,
      error:
        "A personal agent only runs on your own tasks. Assign this task to yourself, or pick one of the project's agents.",
    };
  }

  if (!isRunnable(normaliseComposition(found.composition))) {
    return {
      ok: false,
      error: `"${found.name}" has no steps in it yet, so a machine handed this task would have nothing to run. Add at least one step to it first.`,
    };
  }
  return { ok: true };
}

export async function personalAgentAlienTo(agent: unknown, assigneeAfter: unknown): Promise<boolean> {
  const { Agent } = await import("@/models/agent");
  const found = await Agent.findById(agent, "scope owner").lean();
  if (!found || found.scope !== "user") return false;
  return String(found.owner) !== refId(assigneeAfter);
}

async function sprintBelongsToProject(projectId: string, sprint: unknown): Promise<boolean> {
  if (typeof sprint !== "string" || !Types.ObjectId.isValid(sprint)) return false;
  return (await Sprint.exists({ _id: sprint, project: projectId })) !== null;
}

function titleOrRefusal(value: unknown): string | TaskServiceResult {
  if (typeof value !== "string" || rendersBlank(value)) {
    return { ok: false, error: "Title is required", status: 400 };
  }
  const title = value.trim();
  if (!isValidTaskTitle(title)) {
    return { ok: false, error: TASK_TITLE_RULE, status: 400 };
  }
  return title;
}

function casterFor(field: string): { cast: (value: unknown) => unknown } {
  const [head, ...rest] = field.split(".");
  const path = Task.schema?.path(head);
  const resolved = rest.length
    ? (path as unknown as { schema?: { path: (p: string) => unknown } } | undefined)?.schema?.path(
        rest.join(".")
      )
    : path;
  if (!resolved) {
    throw new Error(`task-service: the Task schema has no path "${field}"`);
  }
  return resolved as { cast: (value: unknown) => unknown };
}

function castsToSchema(field: string, value: unknown): boolean {
  const caster = casterFor(field);
  try {
    caster.cast(value);
    return true;
  } catch (error) {
    return (error as { name?: string } | null)?.name !== "CastError";
  }
}

interface ChecklistInput {
  text: string;
  done?: unknown;
  _id?: unknown;
}

function checklistOrRefusal(value: unknown): ChecklistInput[] | TaskServiceResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: "Checklist must be a list of criteria", status: 400 };
  }
  const items: ChecklistInput[] = [];
  for (const raw of value) {
    const text = (raw as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || rendersBlank(text)) {
      return { ok: false, error: "An acceptance criterion is required", status: 400 };
    }
    if (!isValidCriterionText(text.trim())) {
      return { ok: false, error: CRITERION_TEXT_RULE, status: 400 };
    }
    const row = (raw ?? {}) as Record<string, unknown>;
    const item: ChecklistInput = { text: text.trim() };

    if ("done" in row && row.done !== null) {
      if (!castsToSchema("checklist.done", row.done)) {
        return { ok: false, error: "A criterion is either done or it is not", status: 400 };
      }
      item.done = row.done;
    }

    if ("_id" in row && row._id !== null && row._id !== "") {
      if (!castsToSchema("checklist._id", row._id)) {
        return { ok: false, error: "A criterion's id is not an id", status: 400 };
      }
      item._id = row._id;
    }

    items.push(item);
  }
  return items;
}

function castsToDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string" && typeof value !== "number") return false;
  return !Number.isNaN(new Date(value).getTime());
}

function schemaValuesOrRefusal(values: Body): TaskServiceResult | null {
  if ("priority" in values && !PRIORITIES.includes(values.priority)) {
    return {
      ok: false,
      error: `Invalid priority "${String(values.priority).slice(0, 64)}" — must be one of: ${PRIORITIES.join(", ")}`,
      status: 400,
    };
  }

  const dueDate = values.dueDate;
  if ("dueDate" in values && dueDate !== null && dueDate !== "" && !castsToDate(dueDate)) {
    return { ok: false, error: `Invalid due date "${String(dueDate).slice(0, 64)}"`, status: 400 };
  }

  if ("description" in values && !castsToSchema("description", values.description)) {
    return { ok: false, error: "Description must be text", status: 400 };
  }

  if ("order" in values && !castsToSchema("order", values.order)) {
    return { ok: false, error: "Order must be a number", status: 400 };
  }

  if ("category" in values && !castsToSchema("category", values.category)) {
    return { ok: false, error: "Category must be text", status: 400 };
  }

  return null;
}

export async function createTask(
  projectId: string,
  actorId: string,
  body: Body,
  onWhoseInstruction: string | null = null
): Promise<TaskServiceResult> {
  await connectDB();

  const title = titleOrRefusal(body.title);
  if (typeof title !== "string") return title;

  const checklist = Array.isArray(body.checklist)
    ? checklistOrRefusal(body.checklist)
    : checklistOrRefusal(
        parseChecklistString(
          Array.isArray(body.acceptanceCriteria)
            ? body.acceptanceCriteria.join("\n")
            : (body.acceptanceCriteria ?? "")
        )
      );
  if (!Array.isArray(checklist)) return checklist;

  const board = await Project.findById(projectId, "categories columns customFields").lean();

  if (!board) {
    return { ok: false, error: "Project not found", status: 404 };
  }

  const categoryNames = (board.categories || []).map((c) => c.name);
  const category =
    body.category ??
    (categoryNames.includes("user-story") ? "user-story" : categoryNames[0] ?? "user-story");
  if (categoryNames.length > 0 && !categoryNames.includes(category)) {
    return {
      ok: false,
      error: `Invalid category "${String(category).slice(0, 64)}" — project categories: ${categoryNames.join(", ")}`,
      status: 400,
    };
  }

  const columnIds = getColumnIds(board);
  const status = body.status ?? defaultStatusFor(board);
  if (!columnIds.includes(status)) {
    return {
      ok: false,
      error: `Invalid status "${String(status).slice(0, 64)}" — project columns: ${columnIds.join(", ")}`,
      status: 400,
    };
  }

  let assigneeId = null;
  if (body.assignee !== undefined && body.assignee !== null && body.assignee !== "") {
    const resolved = await resolveAssignee(body.assignee);
    if (!("user" in resolved)) return resolved;
    if (!(await canBeAssigned(String(resolved.user._id), projectId))) {
      return { ok: false, error: noAccessToAssign(resolved.user.username), status: 400 };
    }
    assigneeId = resolved.user._id;
  }

  const priority = body.priority ?? DEFAULT_PRIORITY;
  const dueDate = body.dueDate || null;
  const normalised = normaliseRecurrence(body.recurrence);
  if (!normalised.ok) return { ok: false, error: normalised.error, status: 400 };
  const recurrence = normalised.value;
  const description = body.description ?? "";
  const order = body.order ?? 0;
  const schemaRefusal = schemaValuesOrRefusal({
    priority,
    dueDate,
    recurrence,
    description,
    order,
    category,
  });
  if (schemaRefusal) return schemaRefusal;

  const sprint = (await sprintBelongsToProject(projectId, body.sprint)) ? body.sprint : null;
  const customFieldValues = (() => {
    const raw = body.customFieldValues || {};
    if (typeof raw !== "object" || Array.isArray(raw)) return {};
    const defs = board.customFields || [];
    const sanitized = sanitizeCustomFieldValues(raw, defs);
    const result = validateCustomFieldValues(sanitized, defs);
    return result.valid ? sanitized : {};
  })();

  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { returnDocument: "after" }
  );

  if (!project) {
    return { ok: false, error: "Project not found", status: 404 };
  }

  const task = await Task.create({
    project: projectId,
    taskNumber: project.taskCounter,
    title,
    description,
    priority,
    category,
    status,
    assignee: assigneeId,
    assignedBy: assigneeId ? actorId : null,
    pmAssignedFor: assigneeId ? onWhoseInstruction : null,
    dueDate,
    checklist: checklist as ITask["checklist"],
    sprint,
    customFieldValues,
    recurrence,
    order,
    createdBy: actorId,
  });

  const populated = await Task.findById(task._id).populate(taskPopulateFields);

  await logActivity(String(task._id), actorId, "created");

  const eventPayload = {
    project: { key: project.key, name: project.name },
    task: {
      taskKey: taskKeyOf(project.key, task.taskNumber),
      title: task.title,
      status: task.status,
    },
  };
  dispatchWebhooks(projectId, "task_created", eventPayload);
  dispatchNotifications(projectId, "task_created", eventPayload);

  const createdKey = taskKeyOf(project.key, task.taskNumber);
  notifyBoardFeed({
    taskId: String(task._id),
    projectId,
    actorId,
    title: `New task ${createdKey} in ${project.name}`,
    body: task.title,
    email: async () => {
      const column = getProjectColumns(project).find((c) => c.id === status);
      return {
        kicker: "New on the board",
        taskKey: createdKey,
        taskTitle: task.title,
        taskPills: [
          { label: column?.label ?? status, tone: pillToneForRole(column?.role) },
          { label: capitalise(String(task.priority ?? DEFAULT_PRIORITY)), tone: "neutral" },
        ],
        taskMeta: [project.name, `created by ${await usernameOf(actorId)}`].filter(Boolean).join(" · "),
        projectRef: project.key,
        taskNumber: task.taskNumber,
      };
    },
  });

  if (assigneeId) {
    const taskKey = taskKeyOf(project.key, task.taskNumber);
    const column = getProjectColumns(project).find((c) => c.id === status);
    createNotifications({
      type: "task_assigned",
      taskId: String(task._id),
      projectId,
      actorId,
      title: `${taskKey} assigned to you`,
      body: task.title,
      recipientIds: [String(assigneeId)],
      email: {
        kicker: "Assigned to you",
        taskKey,
        taskTitle: task.title,
        taskPills: [
          { label: column?.label ?? status, tone: pillToneForRole(column?.role) },
          { label: capitalise(String(task.priority ?? DEFAULT_PRIORITY)), tone: "neutral" },
        ],
        taskMeta: [project.name, `created by ${await usernameOf(actorId)}`]
          .filter(Boolean)
          .join(" · "),
        projectRef: project.key,
        taskNumber: task.taskNumber,
        assigneeId: String(assigneeId),
      },
    });
  }

  return { ok: true, data: populated as ITask };
}

export interface StatusChangeOptions {
  force?: boolean;
  workerId?: string;
}

export async function changeStatus(
  projectId: string,
  taskId: string,
  status: string,
  actorId: string,
  options: StatusChangeOptions | boolean = {}
): Promise<TaskServiceResult> {
  const { force = false, workerId: callerWorkerId } =
    typeof options === "boolean" ? { force: options, workerId: undefined } : options;

  await connectDB();

  const projectColumns = await Project.findById(projectId, "columns key").lean();
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

  const leavesColumn = oldTask.status !== status;

  if (!force && leavesColumn) {
    const conflict = runHolding(oldTask);
    const byItsHolder = !!conflict && !!callerWorkerId && conflict.workerId === callerWorkerId;
    if (conflict && !byItsHolder) {
      const key = taskKeyOf(projectColumns?.key, oldTask.taskNumber);
      return refuseHeldRun(conflict, key);
    }
  }

  const CHANGE_STATUS_POPULATE = [
    { path: "assignee", select: "username fullName" },
    { path: "createdBy", select: "username fullName" },
    { path: "assignedBy", select: "username fullName" },
  ];

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId, ...(leavesColumn ? { status: oldTask.status } : {}) },
    leavesColumn
      ? [{ $set: { status, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }]
      : [{ $set: { status } }],
    { returnDocument: "after", updatePipeline: true }
  ).populate(CHANGE_STATUS_POPULATE);

  if (!task) {
    if (leavesColumn) {
      const current = await Task.findOne({ _id: taskId, project: projectId }).populate(
        CHANGE_STATUS_POPULATE
      );
      if (current) return { ok: true, data: current as ITask };
    }
    return { ok: false, error: "Task not found", status: 404 };
  }

  if (oldTask.status !== status) {
    await logActivity(taskId, actorId, "status_changed", "status", oldTask.status, status);
    await announceStatusChange({
      projectId,
      taskId,
      oldTask,
      task,
      actorId,
      project: projectColumns,
    });
  }

  return { ok: true, data: task as ITask };
}

interface StatusChangeAnnouncement {
  projectId: string;
  taskId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldTask: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: any;
  actorId: string;
  project: Parameters<typeof roleOf>[0];
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

async function usernameOf(userId: string): Promise<string> {
  const user = await User.findById(userId, "username").lean();
  return user?.username ?? "somebody";
}

async function announceStatusChange(a: StatusChangeAnnouncement): Promise<void> {
  const status = String(a.task.status);
  const eventPayload = {
    project: { key: "", name: "" },
    task: { taskKey: `${a.oldTask.taskNumber}`, title: a.task.title, status },
    data: { oldStatus: a.oldTask.status, newStatus: status },
  };
  dispatchWebhooks(a.projectId, "status_changed", eventPayload);
  dispatchNotifications(a.projectId, "status_changed", eventPayload);

  const [project, actor] = await Promise.all([
    Project.findById(a.projectId, "key name").lean(),
    usernameOf(a.actorId),
  ]);
  const taskKey = taskKeyOf(project?.key, a.task.taskNumber);
  const columns = getProjectColumns(a.project);
  const from = columns.find((c) => c.id === String(a.oldTask.status));
  const to = columns.find((c) => c.id === status);
  const toLabel = to?.label ?? status;
  createNotifications({
    type: "status_changed",
    taskId: a.taskId,
    projectId: a.projectId,
    actorId: a.actorId,
    title: `${taskKey} moved to ${toLabel}`,
    body: a.task.title,
    recipientIds: collectRecipients(a.task),
    email: {
      kicker: "Status changed",
      taskKey,
      taskTitle: a.task.title,
      taskPills: [
        { label: from?.label ?? String(a.oldTask.status), tone: pillToneForRole(from?.role) },
        "arrow",
        { label: toLabel, tone: pillToneForRole(to?.role) },
      ],
      taskMeta: [project?.name, `moved by ${actor}`].filter(Boolean).join(" · "),
      projectRef: project?.key,
      taskNumber: a.task.taskNumber,
      assigneeId: assigneeIdOf(a.task),
    },
  });

  const closes =
    roleOf(a.project, status) === "done" && roleOf(a.project, a.oldTask.status) !== "done";
  if (closes && a.oldTask.recurrence) {
    createNextRecurrence(a.oldTask, a.projectId, a.actorId).catch((err) =>
      console.error("Failed to create recurring task:", err)
    );
  }

  onTaskStatusChanged({
    projectId: a.projectId,
    taskId: a.taskId,
    oldStatus: a.oldTask.status,
    newStatus: status,
    actorId: a.actorId,
  }).catch((err) => console.error("PM status trigger failed:", err));
}

export async function updateTask(
  projectId: string,
  taskId: string,
  body: Body,
  actorId: string,
  force = false,
  onWhoseInstruction: string | null = null
): Promise<TaskServiceResult> {
  await connectDB();

  const allowed = [
    "title", "description", "priority", "category",
    "status", "assignee", "dueDate", "checklist", "order", "sprint", "agent", "customFieldValues", "recurrence",
  ];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (updates.title !== undefined) {
    const title = titleOrRefusal(updates.title);
    if (typeof title !== "string") return title;
    updates.title = title;
  }

  if (updates.checklist !== undefined) {
    const checklist = checklistOrRefusal(updates.checklist);
    if (!Array.isArray(checklist)) return checklist;
    updates.checklist = checklist;
  }

  if (updates.recurrence !== undefined) {
    const recurrence = normaliseRecurrence(updates.recurrence);
    if (!recurrence.ok) return { ok: false, error: recurrence.error, status: 400 };
    updates.recurrence = recurrence.value;
  }

  const schemaRefusal = schemaValuesOrRefusal(updates);
  if (schemaRefusal) return schemaRefusal;

  if (updates.sprint === "") updates.sprint = null;
  if (updates.sprint !== undefined && updates.sprint !== null) {
    if (!(await sprintBelongsToProject(projectId, updates.sprint))) {
      return { ok: false, error: "Sprint not found in this project", status: 400 };
    }
  }

  if (updates.agent === "") updates.agent = null;

  if (updates.category !== undefined || updates.status !== undefined) {
    const proj = await Project.findById(projectId, "categories columns").lean();
    if (updates.category !== undefined) {
      const names = (proj?.categories || []).map((c) => c.name);
      if (names.length > 0 && !names.includes(String(updates.category))) {
        return {
          ok: false,
          error: `Invalid category "${String(updates.category).slice(0, 64)}" — project categories: ${names.join(", ")}`,
          status: 400,
        };
      }
    }
    if (updates.status !== undefined) {
      const columnIds = getColumnIds(proj);
      if (!columnIds.includes(String(updates.status))) {
        return {
          ok: false,
          error: `Invalid status "${String(updates.status).slice(0, 64)}" — project columns: ${columnIds.join(", ")}`,
          status: 400,
        };
      }
    }
  }

  if (body.acceptanceCriteria !== undefined && updates.checklist === undefined) {
    const acText = Array.isArray(body.acceptanceCriteria)
      ? body.acceptanceCriteria.join("\n")
      : body.acceptanceCriteria;
    const parsed = checklistOrRefusal(parseChecklistString(acText));
    if (!Array.isArray(parsed)) return parsed;
    updates.checklist = parsed;
  }

  let fieldDefs: ICustomField[] = [];
  if (updates.customFieldValues !== undefined) {
    const raw = updates.customFieldValues;
    const project = await Project.findById(projectId, "customFields").lean();
    fieldDefs = project?.customFields || [];
    if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
      updates.customFieldValues = {};
    } else {
      const sanitized = sanitizeCustomFieldValues(raw as Record<string, unknown>, fieldDefs);
      const result = validateCustomFieldValues(sanitized, fieldDefs);
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

  if (updates.recurrence !== undefined && updates.dueDate === undefined) {
    const incoming = updates.recurrence as NormalisedRecurrence | null;
    const kept = keptAnchor(oldTask.recurrence, incoming);
    if (incoming && kept !== null) incoming.anchorDay = kept;
  } else if (updates.dueDate !== undefined && updates.recurrence === undefined && oldTask.recurrence) {
    updates["recurrence.anchorDay"] = null;
  }

  if (updates.assignee === "") updates.assignee = null;

  if (updates.assignee !== undefined && updates.assignee !== null) {
    const resolved = await resolveAssignee(updates.assignee);
    if (!("user" in resolved)) return resolved;
    updates.assignee = resolved.user._id;
  }

  const before = oldTask.assignee as { _id?: unknown } | null | undefined;
  const storedAssignee = String((before && before._id) ?? before ?? "");

  if (
    updates.assignee != null &&
    String(updates.assignee) !== storedAssignee &&
    !(await canBeAssigned(String(updates.assignee), projectId))
  ) {
    const who = await User.findById(updates.assignee, "username").lean();
    return { ok: false, error: noAccessToAssign(who?.username), status: 400 };
  }
  if (updates.assignee !== undefined) {
    const moved = storedAssignee !== String(updates.assignee ?? "");
    const takesItOn = !oldTask.assignedBy && String(actorId) === String(updates.assignee ?? "");
    if (moved || takesItOn) {
      updates.assignedBy = actorId;
      updates.pmAssignedFor = onWhoseInstruction;
    }
  }

  const leavesColumn =
    updates.status !== undefined && String(updates.status) !== String(oldTask.status);

  if (!force && leavesColumn) {
    const conflict = runHolding(oldTask);
    if (conflict) {
      const keyed = await Project.findById(projectId, "key").lean();
      const key = taskKeyOf(keyed?.key, oldTask.taskNumber);
      return refuseHeldRun(conflict, key);
    }
  }

  const onlyOrder = updates.order !== undefined && Object.keys(updates).length === 1;

  const heldByRun = !!oldTask.execution?.runId;
  const claimAssigned = oldTask.execution?.assignedByRun !== false;
  const releasesWorker = leavesColumn && heldByRun && claimAssigned;
  const setFields: Record<string, unknown> = releasesWorker
    ? { assignee: null, assignedBy: null, ...updates }
    : updates;

  const writesNothing = Object.keys(setFields).length === 0 && !leavesColumn;

  const assigneeAfter = "assignee" in setFields ? setFields.assignee : storedAssignee;
  const handsItOver =
    refId(assigneeAfter) !== storedAssignee || updates.assignedBy !== undefined;

  if (updates.agent !== undefined && updates.agent !== null) {
    const usable = await agentUsableOnProject(projectId, updates.agent, actorId, assigneeAfter);
    if (!usable.ok) return { ok: false, error: usable.error, status: 400 };
  }

  if (handsItOver && updates.agent === undefined && oldTask.agent) {
    if (await personalAgentAlienTo(oldTask.agent, assigneeAfter)) setFields.agent = null;
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId, ...(leavesColumn ? { status: oldTask.status } : {}) },
    { $set: setFields, ...(leavesColumn ? { $unset: UNSET_RUN } : {}) },
    { returnDocument: "after", runValidators: true, timestamps: !onlyOrder && !writesNothing }
  ).populate(taskPopulateFields);

  if (!task) {
    if (leavesColumn) {
      const current = await Task.findOne({ _id: taskId, project: projectId }).populate(
        taskPopulateFields
      );
      if (current) return { ok: true, data: current as ITask };
    }
    return { ok: false, error: "Task not found", status: 404 };
  }

  const activities: Promise<void>[] = [];
  const trackFields = ["title", "priority", "category", "status", "agent"];
  for (const field of trackFields) {
    const oldVal = refId(oldTask[field as keyof typeof oldTask]);
    const newVal = refId(task[field as keyof typeof task]);
    if (oldVal !== newVal) {
      const action = field === "status" ? "status_changed" as const : "updated" as const;
      activities.push(logActivity(taskId, actorId, action, field, oldVal, newVal));
    }
  }

  for (const change of customFieldActivityChanges(
    oldTask.customFieldValues,
    task.customFieldValues,
    fieldDefs
  )) {
    activities.push(
      logActivity(taskId, actorId, "updated", change.name, change.before, change.after)
    );
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

  if (updates.status !== undefined && oldTask.status !== task.status) {
    await announceStatusChange({
      projectId,
      taskId,
      oldTask,
      task,
      actorId,
      project: await Project.findById(projectId, "columns").lean(),
    });
  }

  if (updates.assignee !== undefined && task.assignee) {
    const newAssigneeId = typeof task.assignee === "object" && "_id" in task.assignee
      ? String(task.assignee._id)
      : String(task.assignee);
    const [project, actor] = await Promise.all([
      Project.findById(projectId, "key name columns").lean(),
      usernameOf(actorId),
    ]);
    const taskKey = taskKeyOf(project?.key, task.taskNumber);
    const column = getProjectColumns(project).find((c) => c.id === String(task.status));
    createNotifications({
      type: "task_assigned",
      taskId,
      projectId,
      actorId,
      title: `${taskKey} assigned to you`,
      body: task.title,
      recipientIds: [newAssigneeId],
      email: {
        kicker: "Assigned to you",
        taskKey,
        taskTitle: task.title,
        taskPills: [
          { label: column?.label ?? String(task.status), tone: pillToneForRole(column?.role) },
          { label: capitalise(String(task.priority ?? DEFAULT_PRIORITY)), tone: "neutral" },
        ],
        taskMeta: [project?.name, `assigned by ${actor}`].filter(Boolean).join(" · "),
        projectRef: project?.key,
        taskNumber: task.taskNumber,
        assigneeId: newAssigneeId,
      },
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

  const [project, mentionedIds] = await Promise.all([
    Project.findById(projectId, "key name columns").lean(),
    resolveMentions(bodyText),
  ]);
  const taskKey = taskKeyOf(project?.key, task.taskNumber);
  const column = getProjectColumns(project).find((c) => c.id === String(task.status));
  const excerpt = bodyText.trim().substring(0, 120);
  const sharedEmail = {
    taskKey,
    taskTitle: task.title,
    taskPills: [
      { label: column?.label ?? String(task.status), tone: pillToneForRole(column?.role) },
    ],
    taskMeta: project?.name ?? "",
    quote: { who: actor.username, text: excerpt },
    projectRef: project?.key,
    taskNumber: task.taskNumber,
    assigneeId: assigneeIdOf(task),
  };

  const mentioned = new Set(mentionedIds);
  const commentRecipients = collectRecipients(task).filter((id) => !mentioned.has(id));
  if (commentRecipients.length > 0) {
    createNotifications({
      type: "comment_added",
      taskId,
      projectId,
      actorId: actor.id,
      title: `New comment on ${taskKey}`,
      body: excerpt,
      recipientIds: commentRecipients,
      email: { kicker: "New comment", ...sharedEmail },
    });
  }

  if (mentionedIds.length > 0) {
    createNotifications({
      type: "mentioned",
      taskId,
      projectId,
      actorId: actor.id,
      title: `${actor.username} mentioned you in ${taskKey}`,
      body: excerpt,
      recipientIds: mentionedIds,
      email: { kicker: "You were mentioned", ...sharedEmail },
    });
  }

  return { ok: true, data: populated };
}

export async function assignTask(
  projectId: string,
  taskId: string,
  username: string | null,
  actorId: string,
  onWhoseInstruction: string | null = null
): Promise<TaskServiceResult> {
  return updateTask(projectId, taskId, { assignee: username }, actorId, false, onWhoseInstruction);
}

async function createNextRecurrence(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldTask: any,
  projectId: string,
  userId: string
): Promise<void> {
  const { ended, dueDate: nextDue, anchorDay } = nextOccurrence(oldTask.recurrence, oldTask.dueDate);
  if (ended) return;

  if (await Task.exists({ recurringParentId: oldTask._id })) return;

  const project = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { returnDocument: "after" }
  );
  if (!project) return;

  const checklist = undoneChecklist(oldTask.checklist);

  await Task.create({
    project: projectId,
    taskNumber: project.taskCounter,
    title: oldTask.title,
    description: oldTask.description || "",
    priority: oldTask.priority || DEFAULT_PRIORITY,
    category: oldTask.category || "user-story",
    status: defaultStatusFor(project),
    assignee: oldTask.assignee,
    assignedBy: oldTask.assignedBy,
    agent: oldTask.agent ?? null,
    dueDate: nextDue,
    checklist,
    recurrence: {
      frequency: oldTask.recurrence.frequency,
      interval: oldTask.recurrence.interval,
      endDate: oldTask.recurrence.endDate ?? null,
      anchorDay,
    },
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

  const project = await Project.findById(projectId, "columns key name").lean();
  const columns = getProjectColumns(project);
  const approved = columns.find((c) => c.role === "approved")?.id;
  const active = columns.filter((c) => c.role === "active").map((c) => c.id);
  if (!approved || active.length === 0) return 0;

  const exhausted = escalationColumnId(columns) ?? approved;
  const expired = {
    project: projectId,
    status: { $in: active },
    "execution.startedAt": { $lt: new Date(now.getTime() - EXECUTION_LEASE_MS) },
  };
  const outOfAttempts = { ...expired, "execution.attempts": { $gte: MAX_EXECUTION_ATTEMPTS } };

  const abandoned = await Task.find(
    outOfAttempts,
    "taskNumber title assignee watchers execution.workerId"
  ).lean();

  const [spent, retryable] = await Promise.all([
    Task.updateMany(
      outOfAttempts,
      [{ $set: { status: exhausted, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }],
      { updatePipeline: true }
    ),
    Task.updateMany(
      { ...expired, "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      [{ $set: { status: approved, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }],
      { updatePipeline: true }
    ),
  ]);

  if (spent.modifiedCount > 0) {
    announceAbandonedRuns(projectId, project, abandoned, exhausted, columns).catch((err) =>
      console.error("Failed to announce an abandoned run:", err)
    );
  }

  return spent.modifiedCount + retryable.modifiedCount;
}

async function announceAbandonedRuns(
  projectId: string,
  project: { key?: string; name?: string } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: any[],
  exhausted: string,
  columns: ReturnType<typeof getProjectColumns>
): Promise<void> {
  const column = columns.find((c) => c.id === exhausted);
  for (const task of tasks) {
    const taskKey = taskKeyOf(project?.key, task.taskNumber);
    const recipients = collectRecipients(task);
    if (recipients.length === 0) continue;
    const workerId = task.execution?.workerId;
    const actor = workerId
      ? await User.findOne({ username: workerUsername(String(workerId)) }, "_id").lean()
      : null;
    if (!actor) continue;
    createNotifications({
      type: "status_changed",
      taskId: String(task._id),
      projectId,
      actorId: String(actor._id),
      title: `${taskKey} needs a human — the run was abandoned`,
      body: task.title,
      recipientIds: recipients,
      email: {
        kicker: "Run abandoned",
        taskKey,
        taskTitle: task.title,
        taskPills: [
          { label: column?.label ?? exhausted, tone: pillToneForRole(column?.role) },
        ],
        taskMeta: [project?.name, `no worker report in ${EXECUTION_LEASE_MS / 3_600_000} h`]
          .filter(Boolean)
          .join(" · "),
        projectRef: project?.key,
        taskNumber: task.taskNumber,
        assigneeId: assigneeIdOf(task),
      },
    });
  }
}

async function openBlockersFor(
  projectId: string,
  approved: string[],
  done: string[]
): Promise<Types.ObjectId[]> {
  const waiting = await Task.find(
    { project: projectId, status: { $in: approved }, blockedBy: { $exists: true, $ne: [] } },
    "blockedBy"
  ).lean();

  const named = [
    ...new Set(waiting.flatMap((t) => (t.blockedBy ?? []).map(String))),
  ].filter((id) => Types.ObjectId.isValid(id));
  if (named.length === 0) return [];

  const open = await Task.find(
    { project: projectId, _id: { $in: named }, status: { $nin: done } },
    "_id"
  ).lean();
  return open.map((t) => t._id);
}

export async function claimNextTask(
  projectId: string,
  workerId: string,
  runId: string,
  ownerId?: string | null
): Promise<HydratedDocument<ITask> | null> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  for (const role of ROLES_A_RUN_NEEDS) {
    if (!columns.some((c) => c.role === role)) throw new BoardCannotClaim(role);
  }
  const approved = columns.filter((c) => c.role === "approved").map((c) => c.id);
  const activeStatus = columns.find((c) => c.role === "active")!.id;

  if (!ownerId || !Types.ObjectId.isValid(ownerId)) return null;

  const openBlockers = await openBlockersFor(projectId, approved, columnIdsWithRole(project, "done"));

  const pm = await pmUserId();

  return Task.findOneAndUpdate(
    {
      project: projectId,
      status: { $in: approved },
      assignee: ownerId,
      $and: [
        {
          $or: [
            { assignedBy: ownerId },
            ...(pm ? [{ assignedBy: pm, pmAssignedFor: ownerId }] : []),
          ],
        },
      ],
      agent: { $ne: null },
      blockedBy: { $nin: openBlockers },
      $or: [
        { "execution.attempts": { $exists: false } },
        { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      ],
    },
    [
      {
        $set: {
          status: activeStatus,
          "execution.assignedByRun": false,
          "execution.workerId": { $literal: workerId },
          "execution.runId": { $literal: runId },
          "execution.startedAt": new Date(),
          "execution.lastError": "",
          "execution.attempts": { $add: [{ $ifNull: ["$execution.attempts", 0] }, 1] },
        },
      },
      { $unset: PHASE_FIELDS },
    ],
    { returnDocument: "after", sort: { order: 1, createdAt: 1 }, updatePipeline: true }
  );
}

export async function releaseTask(
  projectId: string,
  taskId: string,
  options: { refund?: boolean; workerId?: string } = {}
): Promise<ITask | null> {
  await connectDB();

  const held = options.workerId
    ? { ...STILL_HELD, "execution.workerId": options.workerId }
    : STILL_HELD;

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  const approved = columns.find((c) => c.role === "approved")?.id;
  const active = columns.filter((c) => c.role === "active").map((c) => c.id);
  if (!approved || active.length === 0) return null;

  if (options.refund === false) {
    const exhausted = escalationColumnId(columns) ?? approved;

    return Task.findOneAndUpdate(
      { _id: taskId, project: projectId, status: { $in: active }, ...held },
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
            ...CLEAR_WORKER_ASSIGNEE,
          },
        },
        { $unset: RUN_FIELDS },
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
      ...held,
    },
    [
      {
        $set: {
          status: approved,
          "execution.attempts": { $add: ["$execution.attempts", -1] },
          ...CLEAR_WORKER_ASSIGNEE,
        },
      },
      { $unset: RUN_FIELDS },
    ],
    { returnDocument: "after", updatePipeline: true }
  );
}

export interface TaskPhaseUpdate {
  taskId: string;
  workerId: string;
  runId: string;
  seq: number;
  phase: string;
}

export function phaseFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phase = value.trim();
  if (!phase || phase.length > MAX_PHASE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(phase)) return null;
  return phase;
}

export async function recordTaskPhase(event: TaskPhaseUpdate): Promise<boolean> {
  await connectDB();

  const result = await Task.updateOne(
    {
      _id: event.taskId,
      "execution.workerId": event.workerId,
      "execution.runId": event.runId,
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

export function toApiExecution(
  execution: ITaskExecution | undefined,
  workerNames?: ReadonlyMap<string, string>
): ApiTaskExecution | undefined {
  if (!execution?.runId) return undefined;
  return {
    ...(execution.workerId ? { workerId: execution.workerId } : {}),
    ...(execution.workerId && workerNames?.get(execution.workerId)
      ? { workerName: workerNames.get(execution.workerId)! }
      : {}),
    ...(execution.phase ? { phase: execution.phase } : {}),
    phaseAt: execution.phaseAt ? new Date(execution.phaseAt).toISOString() : null,
    startedAt: execution.startedAt ? new Date(execution.startedAt).toISOString() : null,
    asOf: new Date().toISOString(),
  };
}
