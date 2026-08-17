import { HydratedDocument, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { Comment } from "@/models/comment";
import { Worker } from "@/models/worker";
import { Sprint } from "@/models/sprint";
import { ApiTaskExecution, ICustomField, ITask, ITaskExecution, RunConflict, DEFAULT_PRIORITY } from "@/types";
import { getColumnIds, defaultStatusFor, roleOf, getProjectColumns, columnIdsWithRole } from "@/lib/columns";
import { escalationColumnId } from "@/lib/escalation";
import { logActivity } from "@/lib/activity";
import { dispatchWebhooks } from "@/lib/webhooks";
import { dispatchNotifications } from "@/lib/notifications";
import { createNotifications, collectRecipients, resolveMentions } from "@/lib/in-app-notifications";
import { parseChecklistString } from "@/lib/checklist";
import {
  validateCustomFieldValues,
  sanitizeCustomFieldValues,
  customFieldActivityChanges,
} from "@/lib/custom-fields";
import { onTaskStatusChanged } from "@/lib/pm/triggers";

export const MAX_EXECUTION_ATTEMPTS = 3;

// Long enough for "gates:build" or "Edit src/lib/task-service.ts", short enough that a badge
// cannot become a payload
export const MAX_PHASE_LENGTH = 120;

const PHASE_FIELDS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
// A run's identity has to die with the run. recordTaskPhase matches on runId, so a runId left
// behind on a released task lets that worker replay its own old run onto a task it no longer holds
// — and the release unsets phaseSeq, so the $exists branch would accept any seq, stale ones too.
const RUN_FIELDS = [...PHASE_FIELDS, "execution.runId"];
const UNSET_RUN = Object.fromEntries(RUN_FIELDS.map((field) => [field, ""]));

// A worker that claimed an unassigned task assigns it to itself, and that assignment has to die
// with the run — every way back to the board, or the task is left assigned to a machine that is not
// running it and no worker will ever claim it again.
//
// Conditional, not unconditional: these same updates are what a person dragging a card goes
// through, and clearing their assignment would be a bug of its own.
//
// Two conditions, and both got here by being wrong first.
//
// `runId`, not `workerId`: workerId is deliberately left behind when a run ends — every reader
// pairs it with runId to tell a live run from a memory of one. Keying on it here meant an ordinary
// status change on a long-finished task still cleared its assignee, so "assign it to claude, then
// drag it to To Do" quietly undid the assignment. Under claimScope "assigned" that is the whole
// hand-over, and the worker would simply never pick the task up.
//
// `assignedByRun` says the claim is what put the assignee there. A claim may now land on a task a
// person assigned, and releasing it must give the task back to that person rather than blank the
// field — a released task with no assignee drops out of what the worker may claim and is never
// retried. Missing means true: tasks claimed before this field existed went through a filter that
// refused any assignee, so back then the run really did set it.
//
// `$ifNull` alone was wrong and shipped once: `execution.runId` defaults to the empty string, and
// an empty string is TRUTHY in MongoDB's `$cond` — unlike in JavaScript. So every ordinary status
// change cleared the assignee of every task that had ever been near the execution subdocument.
// Compare explicitly; do not lean on truthiness across that boundary.
const RUN_RELEASES_ASSIGNEE = {
  $and: [
    { $ne: [{ $ifNull: ["$execution.runId", ""] }, ""] },
    { $eq: [{ $ifNull: ["$execution.assignedByRun", true] }, true] },
  ],
};

// assignedBy mirrors assignee on the same condition: a clear that leaves no assignee must leave no
// assignedBy either, or it goes on describing a person who has nothing to do with the empty field.
export const CLEAR_WORKER_ASSIGNEE = {
  assignee: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignee"] },
  assignedBy: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignedBy"] },
};

// A release only applies to a task the run still holds. Status alone is not enough: a board may
// define two columns with the active role, and a forced move between them leaves the task active
// while the run is already gone — the release would then pull it back to the approved column and
// spend an attempt for a move somebody made deliberately.
const STILL_HELD = { "execution.runId": { $nin: ["", null] } };

// claimNextTask's own signal for whether the task had no assignee before the claim — reused for
// both execution.assignedByRun and assignedBy, so a claim that is not what assigned the task
// changes neither field.
export const WAS_UNASSIGNED = { $eq: [{ $ifNull: ["$assignee", null] }, null] };

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
  | { ok: false; error: string; status: number; runConflict?: RunConflict };

/**
 * A run still holding this task, or null. Keyed on runId: every exit from the active column
 * clears it, while workerId and startedAt are left behind as history.
 *
 * Deliberately not judged by silence. `agent` reports on tool use rather than on a clock, so a
 * worker thinking hard for several minutes looks identical to a dead one — and guessing wrong
 * throws away real work. Staleness is the lease's job (EXECUTION_LEASE_MS); taking a task from a
 * machine early is a person's decision, made through `force`.
 */
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

async function refuseHeldRun(conflict: RunConflict, taskKey: string): Promise<TaskServiceResult> {
  const worker = conflict.workerId
    ? await Worker.findById(conflict.workerId, "name").lean()
    : null;
  const name = (worker?.name as string) || conflict.workerId || "a worker";
  return {
    ok: false,
    error: `${taskKey} is being executed by ${name} (phase ${conflict.phase}). Stop the worker, or move it anyway to take the task from it.`,
    status: 409,
    runConflict: { ...conflict, ...(worker?.name ? { workerName: worker.name as string } : {}) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

/**
 * A task's sprint is written from the request body, and nothing else re-checks it — the sprint
 * routes then read and sweep by sprint id, so a cross-project reference lets one board's task
 * appear in another board's counts and be moved by its sprint completion (BP-314).
 */
/**
 * A project agent belongs to one project and must not be borrowed by another's task — the same
 * shape of cross-project reference BP-314 closed for sprints. Global and personal agents run
 * anywhere their owner can reach.
 */
async function agentUsableOnProject(
  projectId: string,
  agent: unknown,
  actingUserId: unknown
): Promise<boolean> {
  if (typeof agent !== "string" || !Types.ObjectId.isValid(agent)) return false;
  const { Agent } = await import("@/models/agent");
  const found = await Agent.findById(agent, "scope project owner").lean();
  if (!found) return false;
  if (found.scope === "project") return String(found.project) === String(projectId);
  // A personal agent is somebody's own; pointing a task at another person's would run their
  // prompts, with write access, on this project's checkout.
  if (found.scope === "user") return String(found.owner) === String(actingUserId);
  return true;
}

async function sprintBelongsToProject(projectId: string, sprint: unknown): Promise<boolean> {
  if (typeof sprint !== "string" || !Types.ObjectId.isValid(sprint)) return false;
  return (await Sprint.exists({ _id: sprint, project: projectId })) !== null;
}

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
    priority: body.priority ?? DEFAULT_PRIORITY,
    category,
    status,
    assignee: assigneeId,
    assignedBy: assigneeId ? actorId : null,
    dueDate: body.dueDate || null,
    checklist: Array.isArray(body.checklist)
      ? body.checklist
      : parseChecklistString(
          Array.isArray(body.acceptanceCriteria)
            ? body.acceptanceCriteria.join("\n")
            : (body.acceptanceCriteria ?? "")
        ),
    sprint: (await sprintBelongsToProject(projectId, body.sprint)) ? body.sprint : null,
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

export interface StatusChangeOptions {
  /** A person's "take it from that worker anyway", after being shown the 409. Never a machine's. */
  force?: boolean;
  /**
   * The verified worker id of the caller, when the caller is a worker.
   *
   * The hold exists to stop a task being taken away from the machine running it — which is not
   * something that machine can do to itself. Without this the refusal fired on the holder's own
   * report, so every worker success path answered 409, the outbox retried it forever, and the task
   * sat in the active column until the two-hour lease expired with its work already merged (BP-335).
   */
  workerId?: string;
}

export async function changeStatus(
  projectId: string,
  taskId: string,
  status: string,
  actorId: string,
  options: StatusChangeOptions | boolean = {}
): Promise<TaskServiceResult> {
  // The boolean form is the old signature; kept so a caller passing `true` still means force
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

  // Leaving the column is what releases the run, so that is what has to be refused. Staying put
  // — a reorder, or resending the status already held — never touches the worker.
  //
  // Decided once and used for BOTH the refusal and the write. They used to disagree: the guard was
  // conditional on the status changing while the pipeline below unconditionally unset the run
  // fields, so resending the status a task already held skipped the 409 and still detached the
  // worker — no force needed, so the machine-credential refusal never fired either (BP-320).
  // updateTask has had the conditional shape all along; this is the same rule, finally matching.
  const leavesColumn = oldTask.status !== status;

  if (!force && leavesColumn) {
    const conflict = runHolding(oldTask);
    // The holder is exempt: reporting the outcome of your own run is the run ending, not somebody
    // taking the task off you. Everyone else — another worker, the PM agent, a person without
    // force — is still refused (BP-335).
    const byItsHolder = !!conflict && !!callerWorkerId && conflict.workerId === callerWorkerId;
    if (conflict && !byItsHolder) {
      const key = projectColumns?.key ? `${projectColumns.key}-${oldTask.taskNumber}` : `#${oldTask.taskNumber}`;
      return refuseHeldRun(conflict, key);
    }
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    leavesColumn
      ? [{ $set: { status, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }]
      : [{ $set: { status } }],
    { returnDocument: "after", updatePipeline: true }
  ).populate([
    { path: "assignee", select: "username fullName" },
    { path: "createdBy", select: "username fullName" },
  ]);

  if (!task) {
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
  // The project document, not its columns array: roleOf reads `.columns` itself
  project: Parameters<typeof roleOf>[0];
}

/**
 * Everything a status change sets off, in one place because it has two callers. The board, the
 * right-click menu and the list dropdown all PATCH the status and go through changeStatus; the
 * edit form PUTs the whole task and goes through updateTask. Only the PM trigger was ever copied
 * to the second one, so the same act had two different outcomes with nothing to tell them apart:
 * closing a recurring task from the detail view silently stopped it recurring, and no webhook,
 * no Slack or Discord message and no in-app notification fired for a move made there.
 *
 * Activity logging stays with each caller. changeStatus writes one entry deliberately, and
 * updateTask already writes one through its own field tracking, so logging here would double it.
 */
async function announceStatusChange(a: StatusChangeAnnouncement): Promise<void> {
  const status = String(a.task.status);
  const eventPayload = {
    project: { key: "", name: "" },
    task: { taskKey: `${a.oldTask.taskNumber}`, title: a.task.title, status },
    data: { oldStatus: a.oldTask.status, newStatus: status },
  };
  dispatchWebhooks(a.projectId, "status_changed", eventPayload);
  dispatchNotifications(a.projectId, "status_changed", eventPayload);

  const project = await Project.findById(a.projectId, "key name").lean();
  const taskKey = project ? `${project.key}-${a.task.taskNumber}` : `#${a.task.taskNumber}`;
  createNotifications({
    type: "status_changed",
    taskId: a.taskId,
    projectId: a.projectId,
    actorId: a.actorId,
    title: `${taskKey} → ${status}`,
    body: a.task.title,
    recipientIds: collectRecipients(a.task),
  });

  if (roleOf(a.project, status) === "done" && a.oldTask.recurrence) {
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
  // Whether this caller may choose the task's agent. A boolean rather than a user, because the
  // answer is a property of the *request's* principal: `tokenScoped`, `tokenScope` and the role a
  // scoped token was degraded to are attached in memory by getAuthUser and are not schema fields,
  // so re-loading the actor here would silently promote a scoped token back to admin. The route
  // holds the live principal; it decides. Defaults to false so a caller that says nothing is
  // refused rather than trusted (BP-345).
  mayChooseAgent = false
): Promise<TaskServiceResult> {
  await connectDB();

  // Whitelist allowed fields to prevent overwriting protected fields
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
  if (updates.assignee !== undefined) updates.assignedBy = actorId;

  // "" is what a cleared <select> sends, and it is not a value this field can hold: `sprint` is an
  // ObjectId, so an empty string casts to a CastError and surfaces as a 500. Normalise first, then
  // there is exactly one way to say "no sprint" and one check for everything else.
  if (updates.sprint === "") updates.sprint = null;
  if (updates.sprint !== undefined && updates.sprint !== null) {
    if (!(await sprintBelongsToProject(projectId, updates.sprint))) {
      return { ok: false, error: "Sprint not found in this project", status: 400 };
    }
  }

  if (updates.agent === "") updates.agent = null;
  if (updates.agent !== undefined) {
    // Compared against what is stored, so re-sending the value a task already carries is a no-op
    // rather than a refusal. A REST consumer that GETs, edits a title and PUTs the whole object
    // would otherwise start failing on a field it never touched — the same call BP-354 made for
    // the stored address. Writing an unchanged value changes nothing, so permitting it is safe.
    const stored = await Task.findOne({ _id: taskId, project: projectId }, "agent").lean();
    const changes = String(stored?.agent ?? "") !== String(updates.agent ?? "");
    if (changes && !mayChooseAgent) {
      return {
        ok: false,
        error: "Only an instance admin can choose which agent runs a task",
        status: 403,
      };
    }
    // Clearing counts as changing: null now means nobody runs the task, as real a choice as naming one.
    if (updates.agent !== null && !(await agentUsableOnProject(projectId, updates.agent, actorId))) {
      return { ok: false, error: "That agent cannot run on this project", status: 400 };
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

  // Kept in scope past validation: the same definitions name the fields in the history entries
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

  // Resolve assignee username to ObjectId if provided as string
  if (updates.assignee && typeof updates.assignee === "string") {
    const assigneeUser = await User.findOne({
      username: (updates.assignee as string).toLowerCase(),
    });
    updates.assignee = assigneeUser ? assigneeUser._id : null;
  }

  // The edit form PUTs the whole task, status included, so leaving the active column is
  // as much a release as changeStatus is. Keyed on the value actually changing, not on
  // the field being present: dragging a card within its own column resends the status it
  // already had, and unsetting the run there would detach a worker mid-execution.
  const leavesColumn =
    updates.status !== undefined && String(updates.status) !== String(oldTask.status);

  // Same rule as changeStatus: the edit form and the board both reach this path, and a status
  // that genuinely moves is what takes the task off the worker
  if (!force && leavesColumn) {
    const conflict = runHolding(oldTask);
    if (conflict) {
      const keyed = await Project.findById(projectId, "key").lean();
      const key = keyed?.key ? `${keyed.key}-${oldTask.taskNumber}` : `#${oldTask.taskNumber}`;
      return refuseHeldRun(conflict, key);
    }
  }

  // A pure reorder is not an edit. Without this every card dragged inside a column
  // reads as "updated just now", which is the same lie the list's reorder endpoint
  // already refuses to tell.
  const onlyOrder = updates.order !== undefined && Object.keys(updates).length === 1;

  // Same rule as changeStatus, decided in JS rather than with a pipeline because this update needs
  // runValidators, which a pipeline update does not run. An explicit assignee in the edit still
  // wins — it is spread last.
  // The same two conditions as CLEAR_WORKER_ASSIGNEE, in JS because this update needs
  // runValidators and a pipeline does not run them. workerId is the wrong one: it outlives the run
  // as history, so keying on it cleared the assignee of any task a worker had ever touched — and
  // this is the path a dragged card takes, so "assign it, then drag it" undid the assignment.
  const heldByRun = !!oldTask.execution?.runId;
  const claimAssigned = oldTask.execution?.assignedByRun !== false;
  const releasesWorker = leavesColumn && heldByRun && claimAssigned;
  const setFields = releasesWorker ? { assignee: null, assignedBy: null, ...updates } : updates;

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    leavesColumn ? { $set: setFields, $unset: UNSET_RUN } : { $set: updates },
    { returnDocument: "after", runValidators: true, timestamps: !onlyOrder }
  ).populate(taskPopulateFields);

  if (!task) {
    return { ok: false, error: "Task not found", status: 404 };
  }

  // Log field changes (parallel)
  const activities: Promise<void>[] = [];
  // "agent" is on this list because it is the field that decides what runs on somebody's machine.
  // Without it there is no answer to "who pointed the machine at that prompt" (BP-345).
  const trackFields = ["title", "priority", "category", "status", "agent"];
  for (const field of trackFields) {
    const oldVal = String(oldTask[field as keyof typeof oldTask] ?? "");
    const newVal = String(task[field as keyof typeof task] ?? "");
    if (oldVal !== newVal) {
      const action = field === "status" ? "status_changed" as const : "updated" as const;
      activities.push(logActivity(taskId, actorId, action, field, oldVal, newVal));
    }
  }

  // Since CP-213 the fields a project defines are most of what people actually edit, so a
  // fixed trackFields list leaves the bulk of every change unrecorded.
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

  // The edit form sends status inside the PUT body, so this path sets off the same things a
  // board move does. It used to fire the PM trigger alone, which is the whole of BP-253.
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
    priority: oldTask.priority || DEFAULT_PRIORITY,
    category: oldTask.category || "user-story",
    status: defaultStatusFor(project),
    assignee: oldTask.assignee,
    // Inherited, not stamped with userId: userId is whoever/whatever closed this occurrence, which
    // may be the worker's own identity finishing its run, not the person who owns the series. The
    // next occurrence continues the same standing assignment, so it carries the same assigner.
    assignedBy: oldTask.assignedBy,
    dueDate: nextDue,
    checklist,
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

  const exhausted = escalationColumnId(columns) ?? approved;
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
      [{ $set: { status: exhausted, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }],
      { updatePipeline: true }
    ),
    Task.updateMany(
      { ...expired, "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      [{ $set: { status: approved, ...CLEAR_WORKER_ASSIGNEE } }, { $unset: RUN_FIELDS }],
      { updatePipeline: true }
    ),
  ]);

  return spent.modifiedCount + retryable.modifiedCount;
}

// The blockers that tasks waiting in the approved column actually name, narrowed to those that have
// not finished. Bounded by the work waiting to start rather than by the size of the board: asking
// for every unfinished task instead grew the claim filter with the backlog forever, and could not
// be served from the { project, status } index because _id is not in it.
//
// A blocker always sits in the same project — the links endpoint refuses one that does not — so
// nothing outside this project has to be consulted.
async function openBlockersFor(
  projectId: string,
  approved: string[],
  done: string[]
): Promise<Types.ObjectId[]> {
  const waiting = await Task.find(
    { project: projectId, status: { $in: approved }, blockedBy: { $exists: true, $ne: [] } },
    "blockedBy"
  ).lean();

  // isValid, because these are stored values going back into a query: an id that cannot be cast
  // would reject the claim and stop this project's worker until somebody repaired the data. A
  // blocker nothing can resolve reads as "not open", the same as one that was deleted.
  const named = [
    ...new Set(waiting.flatMap((t) => (t.blockedBy ?? []).map(String))),
  ].filter((id) => Types.ObjectId.isValid(id));
  if (named.length === 0) return [];

  // project, though blockers are same-project today: a foreign blocker would otherwise have its
  // status judged against this board's done ids, and a board that calls finished anything else
  // would freeze the dependent for good. Scoped, it drops out and the dependent goes through.
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
  // The worker's own identity user. A claim is an assignment, which is what stops two machines
  // converging on one task and what makes a task parked for a colleague untouchable.
  identity?: string | null,
  // The machine's owner. A machine takes the work this person handed it, and nothing else.
  ownerId?: string | null
  // A document, not a plain ITask: the caller has to know, because spreading one silently yields
  // Mongoose internals with every real field a level down.
): Promise<HydratedDocument<ITask> | null> {
  await connectDB();

  const project = await Project.findById(projectId, "columns").lean();
  const columns = getProjectColumns(project);
  const approved = columns.filter((c) => c.role === "approved").map((c) => c.id);
  const activeStatus = columns.find((c) => c.role === "active")?.id;
  if (approved.length === 0 || !activeStatus) return null;

  // Cast here, not in the pipeline. Mongoose casts a plain $set against the schema and does not
  // cast an update pipeline at all, so the raw string would be stored in an ObjectId ref field —
  // populate still renders it, and every query that casts its side (My Tasks, the board's assignee
  // filter, this very claim filter) silently stops matching the task.
  // A worker's identity is an ObjectId ref, so one that cannot be parsed means a corrupt worker
  // record. Claim nothing: throwing would 500 the poll loop, and claiming while assigning nobody
  // would hand work to a machine that no later query can associate with it.
  if (identity && !Types.ObjectId.isValid(identity)) return null;
  const assignTo = identity ? new Types.ObjectId(identity) : null;

  // Explicit about presence, not just format: isValid(null | undefined | "") already happens to
  // return false in this bson version, but that is the library's choice, not a guarantee — a
  // missing owner should not depend on it staying that way.
  if (!ownerId || !Types.ObjectId.isValid(ownerId)) return null;

  // Assigned to the owner *by* the owner. Somebody else assigning you work is a proposal, and the
  // surface for accepting one does not exist yet — so it is refused rather than run unattended.
  // A task the run is resuming is already assigned to the machine's identity, and without it a
  // release would hand back a task nothing could pick up again.
  const claimable = [
    { assignee: ownerId, assignedBy: ownerId },
    ...(identity ? [{ assignee: identity }] : []),
  ];

  // Finished is the done role, not a status called "done": a board that renamed its last column
  // would otherwise read every shipped blocker as still open. A board with NO done-role column
  // cannot express "finished" at all, so it cannot express "blocked" either — gating on it would
  // freeze every dependent for good with nothing on the task or in any log saying why, so the gate
  // is skipped there rather than deadlocking the queue.
  //
  // Read before the claim rather than joined inside it, because MongoDB cannot join in an update.
  // The claim itself stays the one atomic findOneAndUpdate it was, so two workers still cannot take
  // the same task.
  //
  // What can age is this gate: it is computed from the approved column as it stood a moment ago.
  // Four ways, all bounded by one round trip, and all of them settle the way acting a millisecond
  // earlier or later already would, since nothing revokes a claim that is already running:
  //   - a blocker finishes in the window — its dependent waits for the next poll;
  //   - a blocker is reopened — its dependent goes through;
  //   - a blocked task is promoted into the approved column — its blocker was not named when this
  //     was computed, so it goes through;
  //   - a blocked_by link is added to a task already in the column — same.
  // Closing the last two means keeping an open-blocker count on the task itself, maintained by
  // every link and status writer, so the gate can live inside the atomic filter. That is a much
  // larger change than this one.
  const done = columnIdsWithRole(project, "done");
  const openBlockers = done.length > 0 ? await openBlockersFor(projectId, approved, done) : [];

  return Task.findOneAndUpdate(
    {
      project: projectId,
      status: { $in: approved },
      // Choosing an agent is the hand-over; a task naming none is one a person is doing
      agent: { $ne: null },
      // On an array field this means "holds none of them", so a task with no blockers, one whose
      // blockers have all finished, and one written before the field existed all still qualify
      blockedBy: { $nin: openBlockers },
      $and: [
        { $or: claimable },
        // Mongoose applies defaults at hydration, so tasks created before the
        // execution subdocument existed have no such field — and $lt never
        // matches a missing one
        {
          $or: [
            { "execution.attempts": { $exists: false } },
            { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
          ],
        },
      ],
    },
    [
      {
        $set: {
          status: activeStatus,
          // Kept, not overwritten: the assignee is the hand-over itself, and whether the claim is
          // what set it decides whether releasing may clear it again.
          // assignedBy follows the same rule on the same signal — the claim is the assigner only
          // when the claim is what set the assignee; a resumed or already-assigned task keeps
          // whatever assignedBy already recorded, same as it keeps assignee.
          ...(assignTo
            ? {
                assignee: { $ifNull: ["$assignee", assignTo] },
                assignedBy: { $cond: [WAS_UNASSIGNED, assignTo, "$assignedBy"] },
              }
            : {}),
          "execution.assignedByRun": WAS_UNASSIGNED,
          "execution.workerId": workerId,
          "execution.runId": runId,
          "execution.startedAt": new Date(),
          "execution.lastError": "",
          "execution.attempts": { $add: [{ $ifNull: ["$execution.attempts", 0] }, 1] },
        },
      },
      // A run counts its own phases from one, so a phaseSeq left by an earlier run would swallow
      // the first events of this one
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

  // "held by SOME run" is enough for a person clearing a stuck task from the board, but not for a
  // worker: without naming the holder, worker A could release worker B's task mid-run, decrementing
  // its attempts or parking it in escalation. Same line the events route already draws (BP-305).
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

// What a reader may see of a run. The subdocument carries more — runId is the authorization scope
// recordTaskPhase matches on, phaseSeq is an ordering detail, lastError is only ever "" and
// attempts counts attempts spent rather than an attempt number — and none of it belongs in a
// browser. Returning the raw document would publish all of it to every project member.
export function toApiExecution(
  execution: ITaskExecution | undefined,
  workerNames?: ReadonlyMap<string, string>
): ApiTaskExecution | undefined {
  // runId is what says a run still holds this task: every exit from the active column clears it,
  // while workerId and startedAt are left behind as history. Keying on those instead would leave a
  // finished task claiming to be starting forever, which is what live testing caught.
  if (!execution?.runId) return undefined;
  return {
    ...(execution.workerId ? { workerId: execution.workerId } : {}),
    // Resolved by the caller, which is the layer that can read the fleet. Absent rather than
    // guessed when it cannot be: a card showing the wrong machine is worse than one showing an id.
    ...(execution.workerId && workerNames?.get(execution.workerId)
      ? { workerName: workerNames.get(execution.workerId)! }
      : {}),
    ...(execution.phase ? { phase: execution.phase } : {}),
    phaseAt: execution.phaseAt ? new Date(execution.phaseAt).toISOString() : null,
    startedAt: execution.startedAt ? new Date(execution.startedAt).toISOString() : null,
    // Both timestamps come from this clock, so a reader's clock must never be compared against
    // them: a browser five minutes fast would call a healthy run silent, and one running behind
    // would show a run dead for hours as alive. Ages are measured here and only advanced there.
    asOf: new Date().toISOString(),
  };
}
