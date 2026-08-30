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

// Long enough for "gates:build" or "Edit src/lib/task-service.ts", short enough that a badge
// cannot become a payload
export const MAX_PHASE_LENGTH = 120;

const PHASE_FIELDS = ["execution.phase", "execution.phaseAt", "execution.phaseSeq"];
// A run's identity has to die with the run. recordTaskPhase matches on runId, so a runId left
// behind on a released task lets that worker replay its own old run onto a task it no longer holds
// — and the release unsets phaseSeq, so the $exists branch would accept any seq, stale ones too.
const RUN_FIELDS = [...PHASE_FIELDS, "execution.runId"];
const UNSET_RUN = Object.fromEntries(RUN_FIELDS.map((field) => [field, ""]));

// A worker used to claim an unassigned task and assign it to itself, and that assignment has to die
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
// drag it to To Do" quietly undid the assignment — assignment is still central to the hand-over,
// and the worker would simply never pick the task up.
//
// `assignedByRun` says the claim is what put the assignee there. Since BP-358 a claim only ever
// takes a task somebody already assigned, so it writes this `false` every time and this half of
// the condition is here for one shrinking population: runs claimed by the older code and still in
// flight across the deploy, plus tasks it already stamped. Releasing a task a person assigned must
// give it back to that person rather than blank the field — a released task with no assignee drops
// out of what the worker may claim and is never retried. Missing means true: tasks claimed before
// this field existed went through a filter that refused any assignee, so back then the run really
// did set it.
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

// assignedBy mirrors assignee on the same condition, and only on this one: a RUN giving back an
// assignment it invented must leave no assigner behind either, or the field goes on describing a
// person who has nothing to do with the empty one. A PERSON unassigning a task is the opposite
// case — there `updateTask` records who did it, because somebody did.
export const CLEAR_WORKER_ASSIGNEE = {
  assignee: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignee"] },
  assignedBy: { $cond: [RUN_RELEASES_ASSIGNEE, null, "$assignedBy"] },
};

// A release only applies to a task the run still holds. Status alone is not enough: a board may
// define two columns with the active role, and a forced move between them leaves the task active
// while the run is already gone — the release would then pull it back to the approved column and
// spend an attempt for a move somebody made deliberately.
const STILL_HELD = { "execution.runId": { $nin: ["", null] } };

// Four times the worker's default task timeout. A worker killed mid-run leaves its task in the
// active column, where claimNextTask can never see it again — nothing else reclaims it.
export const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;

// Named rather than inlined so the board, both forms, MCP and the PM agent all refuse in the same
// words — the message is the only thing telling an agent that the account exists and the access
// does not, which is a different repair from a misspelt username.
function noAccessToAssign(username?: string | null): string {
  const who = username ? `@${username}` : "That account";
  return `${who} has no access to this board, so the task cannot be assigned to them. A board owner can add them in the project's Members settings.`;
}

// The one list, used by task-service's own writes and by both task routes. It was three copies
// until BP-358's review: `assignedBy` had to be added to each, and dropping it from any one left
// that route answering with a bare ObjectId — so the Agent row's "Krzysiek assigned it" degraded
// to "Somebody else assigned it" with nothing failing anywhere.
export const taskPopulateFields = [
  { path: "assignee", select: "username fullName" },
  // Named, not left as an id: this is what the agent picker reads to say why nothing will run a
  // task somebody else handed over, and "assigned by 6a70…" answers nobody's question
  { path: "assignedBy", select: "username fullName" },
  { path: "createdBy", select: "username fullName" },
  // Named for the same reason, and it is the one field on the task that decides what executes:
  // `/api/agents` withholds other people's personal agents, so without the name here the picker
  // cannot resolve the id and renders "No agent" over a task that is carrying one.
  { path: "agent", select: "name" },
  { path: "blockedBy", select: "taskNumber title status" },
  { path: "relations.task", select: "taskNumber title status" },
];

/** The id behind a ref that may or may not have been populated. Guarded first: typeof null is "object". */
function refId(ref: unknown): string {
  return ref && typeof ref === "object" && "_id" in ref
    ? String((ref as { _id: unknown })._id)
    : String(ref ?? "");
}

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

/**
 * The refusal a run-held task gets, for a caller that is not going through `changeStatus` or
 * `updateTask`. Exported so the delete route answers in the wording and the shape the other three
 * writers already answer in, rather than growing a fourth (BP-337).
 *
 * `null` when no run holds the task, which is the ordinary case and reads as "carry on".
 */
export async function heldRunRefusal(
  // The shape runHolding actually reads, not ITaskExecution: demanding the whole subdocument makes
  // every caller build fields this never looks at
  task: { execution?: Parameters<typeof runHolding>[0]["execution"]; taskNumber: number },
  projectKey: string | null | undefined,
  action = "move"
  // Never the success branch: this only ever answers "no, and here is why", so a caller does not
  // have to narrow a union it can never see the other side of
): Promise<Extract<TaskServiceResult, { ok: false }> | null> {
  const conflict = runHolding(task);
  if (!conflict) return null;
  return refuseHeldRun(conflict, taskKeyOf(projectKey, task.taskNumber), action);
}

async function refuseHeldRun(
  conflict: RunConflict,
  taskKey: string,
  // The three writers that move a task say "move it anyway"; delete reaches the same refusal and
  // told the caller to move it, which is advice about a different act (BP-337 review)
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

/**
 * A task's sprint is written from the request body, and nothing else re-checks it — the sprint
 * routes then read and sweep by sprint id, so a cross-project reference lets one board's task
 * appear in another board's counts and be moved by its sprint completion (BP-314).
 */
/**
 * Whether this agent may be written onto this project's task, and why not.
 *
 * A project agent belongs to one project and must not be borrowed by another's task — the same
 * shape of cross-project reference BP-314 closed for sprints. Global and personal agents run
 * anywhere their owner can reach.
 *
 * Runnability is checked here too, because since BP-358 the task's own agent is the only thing
 * that reaches a machine. Every agent is born empty — `NewAgent` carries no composition — and an
 * empty one is a draft, which agent-rules deliberately stores rather than refuses. Written onto a
 * task it becomes a claim the worker cannot serve: `snapshotFor` answers null, the route hands the
 * task straight back, and the task sorts first on the next poll thirty seconds later. That is the
 * task's own queue position, so every other claimable task on the project waits behind it.
 *
 * `assigneeAfter` is who the task belongs to once this update lands, and it is what keeps a
 * personal agent personal. Authoring one is open to anyone, so its steps are a composition nobody
 * vetted — a project agent is project-admin (`/api/agents`), a global one is shipped. A claim runs
 * on the machine of whoever assigned the task to themselves, which need not be whoever chose the
 * agent, so "the actor owns it" alone would let a member compose `merge` with no review gate and
 * point a colleague's self-assigned task at it. `agent-rules` grades that composition risky rather
 * than broken, so it stores; and a step's capability is not something the prompt around it can
 * argue with.
 */
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
  // A personal agent is somebody's own; pointing a task at another person's would run their
  // prompts, with write access, on this project's checkout.
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

/**
 * Whether the agent this task already carries is a personal one the incoming assignee could not
 * have chosen — the only kind a hand-over invalidates.
 *
 * A missing agent answers false rather than clearing: a dangling reference is not somebody's
 * composition, and `DELETE /api/agents/:id` refuses while any task points at one, so this is a
 * hand-edited database rather than a state the product produces.
 */
export async function personalAgentAlienTo(agent: unknown, assigneeAfter: unknown): Promise<boolean> {
  const { Agent } = await import("@/models/agent");
  const found = await Agent.findById(agent, "scope owner").lean();
  if (!found || found.scope !== "user") return false;
  // "" for an unassigned task, which never equals an owner: nobody holds it, so nobody chose it
  return String(found.owner) !== refId(assigneeAfter);
}

async function sprintBelongsToProject(projectId: string, sprint: unknown): Promise<boolean> {
  if (typeof sprint !== "string" || !Types.ObjectId.isValid(sprint)) return false;
  return (await Sprint.exists({ _id: sprint, project: projectId })) !== null;
}

/** A title both writers must agree on: the schema marks it `required` and trims it, so anything
 *  blank is a refusal rather than a write, and the trimmed string is what gets stored.
 *
 *  `trim()` is not the whole of blank, which is the second refusal: a zero-width space survives it
 *  and renders as no title at all, and nothing capped the length at any layer (BP-440). */
function titleOrRefusal(value: unknown): string | TaskServiceResult {
  // `rendersBlank`, not `trim() === ""`: a title of one zero-width space is blank to everybody who
  // looks at it and empty to nobody who measures it, and it kept the older message either way.
  if (typeof value !== "string" || rendersBlank(value)) {
    return { ok: false, error: "Title is required", status: 400 };
  }
  const title = value.trim();
  if (!isValidTaskTitle(title)) {
    return { ok: false, error: TASK_TITLE_RULE, status: 400 };
  }
  return title;
}

/**
 * The schema's own caster for a field, `a.b` reaching into a subdocument array.
 *
 * Throws rather than returning undefined when the path is gone. A guard that cannot ask the caster
 * would otherwise allow every value silently — and the unit suite mocks the model, so a renamed
 * field would take the guard with it and nothing would go red (BP-499).
 */
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

/**
 * Whether the schema's own caster takes this value — asked of the caster rather than restated.
 * `Number([])` is 0 and `Number([5])` is 5, yet Mongoose refuses both, so a hand-rolled rule
 * reading "anything Number() makes finite" lets an array past the guard and into the CastError
 * the guard exists to prevent.
 */
function castsToSchema(field: string, value: unknown): boolean {
  const caster = casterFor(field);
  try {
    caster.cast(value);
    return true;
  } catch (error) {
    // Only a CastError is a refusal. Anything else `cast` throws does not depend on the value, so
    // answering 400 to it would refuse EVERY create with "your description is wrong". A *missing*
    // path is not caught here at all — `casterFor` threw before the try, deliberately.
    return (error as { name?: string } | null)?.name !== "CastError";
  }
}

/**
 * The rows a checklist is made of, as they arrive from a request body. `done` and `_id` are held
 * as they arrived rather than as their types: the write casts them, and a guard that pre-coerced
 * would be a second implementation of the cast.
 */
interface ChecklistInput {
  text: string;
  done?: unknown;
  _id?: unknown;
}

/**
 * The same agreement for acceptance criteria. `checklist[].text` is `required` too, and the raw
 * array arrives straight off the request body — so clearing a criterion on the task screen was the
 * title bug one section lower, byte for byte: the same autosave, the same escaped ValidationError,
 * the same 500. The `acceptanceCriteria` string path never had *that*, because parseChecklistString
 * drops blank lines already — it does have BP-440's, so it goes through here too now.
 *
 * Adding a criterion is unaffected: CriteriaSection refuses to append a blank one, so no legitimate
 * gesture sends an empty text and this can only ever catch the destructive one.
 */
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
    /**
     * Allowlisted, not spread. The spread that stood here kept an existing row's `_id` and `done`
     * — and every other key the body carried, uncast, straight into `Task.create`, which on create
     * is past the `$inc` that mints the task number. `{"done": {}}` and a mangled `_id` were a 500
     * and a permanently burnt number (BP-499). The two worth keeping are judged by the same caster
     * the write will use.
     */
    const row = (raw ?? {}) as Record<string, unknown>;
    const item: ChecklistInput = { text: text.trim() };

    // `null` is dropped rather than stored, the same as `_id` below: the Boolean cast takes it,
    // but `done` is typed as a boolean everywhere that reads it, and the schema default is false.
    if ("done" in row && row.done !== null) {
      if (!castsToSchema("checklist.done", row.done)) {
        return { ok: false, error: "A criterion is either done or it is not", status: 400 };
      }
      item.done = row.done;
    }

    // Blank means a row that has no id yet, which is what the screen sends for a new criterion —
    // dropping the key lets Mongoose mint one, where keeping `null` would store a null id.
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

/** What Mongoose's Date cast accepts: a Date, a timestamp, or a string it can parse. */
function castsToDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string" && typeof value !== "number") return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * The fields the SCHEMA judges rather than either writer: `priority` is an enum, `dueDate` a Date
 * cast, `recurrence` a subdocument whose interval is required. A wrong value on any of them is a
 * ValidationError or a CastError nobody catches, so the route answers 500 where 400 belongs — the
 * same family BP-437 closed for `title` and `checklist[].text`, one field at a time.
 *
 * On create it costs more than the status code: the guard runs before the `$inc` that mints the
 * task number, so a refusal past it would spend a number on a task that never exists. Reachable
 * rather than hypothetical — MCP's `create_task` declares `priority` as a free-form string and
 * forwards it unchecked, so a model writing "critical" got a 500 and a permanent hole in the
 * board's numbering (BP-438).
 *
 * Only the keys actually present are judged: an update writes what it names and nothing else.
 */
function schemaValuesOrRefusal(values: Body): TaskServiceResult | null {
  if ("priority" in values && !PRIORITIES.includes(values.priority)) {
    return {
      ok: false,
      error: `Invalid priority "${values.priority}" — must be one of: ${PRIORITIES.join(", ")}`,
      status: 400,
    };
  }

  // `""` is what a cleared date input sends, and Mongoose's own cast turns it into null the way it
  // does an explicit one — refusing it here would be stricter than the schema this stands in for.
  const dueDate = values.dueDate;
  if ("dueDate" in values && dueDate !== null && dueDate !== "" && !castsToDate(dueDate)) {
    return { ok: false, error: `Invalid due date "${dueDate}"`, status: 400 };
  }

  // Both go straight to the write, so a shape the cast throws on left the route as a 500 — and on
  // create that 500 lands past the `$inc`, spending a task number on a task that never exists
  // (BP-445). Clearing either field is untouched: the caster takes `null` itself, and both writers
  // default an absent one before they ask.
  if ("description" in values && !castsToSchema("description", values.description)) {
    return { ok: false, error: "Description must be text", status: 400 };
  }

  if ("order" in values && !castsToSchema("order", values.order)) {
    return { ok: false, error: "Order must be a number", status: 400 };
  }

  // The name check below is skipped on a board with no categories at all, and the cast is what
  // would then throw. Unreachable today — the delete route refuses to remove the last one — so
  // this closes the case rather than a live hole, and removes the need to know that.
  if ("category" in values && !castsToSchema("category", values.category)) {
    return { ok: false, error: "Category must be text", status: 400 };
  }

  return null;
}

export async function createTask(
  projectId: string,
  actorId: string,
  body: Body,
  // See updateTask's parameter of the same name (BP-419): only the PM's tools pass it.
  onWhoseInstruction: string | null = null
): Promise<TaskServiceResult> {
  await connectDB();

  const title = titleOrRefusal(body.title);
  if (typeof title !== "string") return title;

  // The string form goes through the same guard, and here rather than at the write below: it drops
  // blank lines already, but a criterion of zero-width spaces is not a blank line (BP-440), and a
  // refusal past the `$inc` costs a task number.
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

  // Read, not incremented: minting the task number is what the whole of the validation below has
  // to happen in front of, so the project lookup the category and column lists need is split from
  // the `$inc` that spends a number (BP-438). Every refusal past that point leaves a permanent hole
  // in the board's numbering, for a task that never existed.
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
      error: `Invalid category "${category}" — project categories: ${categoryNames.join(", ")}`,
      status: 400,
    };
  }

  const columnIds = getColumnIds(board);
  const status = body.status ?? defaultStatusFor(board);
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
      if (!(await canBeAssigned(String(assigneeUser._id), projectId))) {
        return { ok: false, error: noAccessToAssign(assigneeUser.username), status: 400 };
      }
      assigneeId = assigneeUser._id;
    }
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

  // Nothing above this line spent a number and nothing below it may refuse: the request is known
  // to be answerable before the counter moves.
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
    // Cast at the write, the way `order` and `description` are: the rows carry `done` and `_id`
    // exactly as the body sent them, judged but not coerced
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
  // The personal counterpart of the shared team channel two lines up. Same event, different
  // audience: that one announces the board to a room nobody subscribed to individually, this one
  // reaches the people who ticked the row for themselves.
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

  // Assigning an existing task told the assignee; creating one already assigned to them said
  // nothing, which is how the MCP, the PM agent and a worker all hand work over.
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
      const key = taskKeyOf(projectColumns?.key, oldTask.taskNumber);
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
    // `assignedBy` too, though nothing feeds this response to the Agent row today: handoverOf tells
    // the PM apart by the username populate puts here, so a caller that ever did would get
    // "somebody else assigned it" printed over a task the machine is about to take. One line, and
    // it removes the whole class rather than documenting it.
    { path: "assignedBy", select: "username fullName" },
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
  // The column's own label, not its id: since CP-128 a project names its columns, and
  // "BP-142 → in_review" is the seeded id showing through on a board that may call it anything.
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

  // The move that CLOSES the task, not any move that lands in a done column: a board may define
  // two of them, and a hop between the two closes nothing — it used to mint an occurrence each way
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
  // Only the PM's own tools pass this, and only ever with the user driving that turn. Deliberately
  // a parameter rather than a field on `body`: `body` is what an HTTP caller sends, and a field on
  // it would let anyone who can PUT a task nominate whose machine may run it (BP-419).
  onWhoseInstruction: string | null = null
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
  // `title` and `checklist[].text` are both `required` on the schema, so a blank one is refused not
  // here but by Mongoose's updateValidators — and a ValidationError nobody catches leaves the route
  // as a 500. The task screen saves on every keystroke, so clearing either field to retype it is
  // the ordinary way in, not an exotic one.
  //
  // Neighbours, not the same shape: the `sprint` and `agent` lines below *normalise* a cleared
  // picker's "" into null, because null is a value those fields can hold. Blank is not a value
  // these two can hold, so they refuse instead.
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

  // The rest of the same family, and the same reason: `priority`, `dueDate` and `recurrence` are
  // all on the whitelist above and all judged by the schema, so a wrong one escaped as a 500 here
  // exactly as it did on create.
  if (updates.recurrence !== undefined) {
    const recurrence = normaliseRecurrence(updates.recurrence);
    if (!recurrence.ok) return { ok: false, error: recurrence.error, status: 400 };
    updates.recurrence = recurrence.value;
  }

  const schemaRefusal = schemaValuesOrRefusal(updates);
  if (schemaRefusal) return schemaRefusal;

  // "" is what a cleared <select> sends, and it is not a value this field can hold: `sprint` is an
  // ObjectId, so an empty string casts to a CastError and surfaces as a 500. Normalise first, then
  // there is exactly one way to say "no sprint" and one check for everything else.
  if (updates.sprint === "") updates.sprint = null;
  if (updates.sprint !== undefined && updates.sprint !== null) {
    if (!(await sprintBelongsToProject(projectId, updates.sprint))) {
      return { ok: false, error: "Sprint not found in this project", status: 400 };
    }
  }

  // "" is what a cleared picker sends, and an ObjectId ref cannot hold it. Normalised here, before
  // anything reads the field, so there is one way to say "no agent" — the check itself has to wait
  // until the assignee this update leaves behind is known.
  if (updates.agent === "") updates.agent = null;

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
    const parsed = checklistOrRefusal(parseChecklistString(acText));
    if (!Array.isArray(parsed)) return parsed;
    updates.checklist = parsed;
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

  // Which day a monthly series falls on, once a short month has clamped it (BP-486). Two rules, and
  // they are about intent rather than about fields:
  //
  //  - Writing `dueDate` IS the person choosing a day, so the anchor is cleared and the next mint
  //    takes it from the date they picked. That is what lets somebody retarget a series by editing
  //    its due date, which is why the anchor cannot simply live at the series' root.
  //  - Writing the rhythm alone is not. Both editors send the whole recurrence back with no anchor
  //    in it, so without carrying the stored one across, changing "every month" to "every 2 months"
  //    would quietly cost a person the 31st they had chosen.
  if (updates.recurrence !== undefined && updates.dueDate === undefined) {
    const incoming = updates.recurrence as NormalisedRecurrence | null;
    const kept = keptAnchor(oldTask.recurrence, incoming);
    if (incoming && kept !== null) incoming.anchorDay = kept;
  } else if (updates.dueDate !== undefined && updates.recurrence === undefined && oldTask.recurrence) {
    // The dotted path, not a whole subdocument: `recurrence` is required-fielded, so replacing it
    // wholesale here would need frequency and interval restated to survive validation.
    updates["recurrence.anchorDay"] = null;
  }

  // Resolve assignee username to ObjectId if provided as string
  if (updates.assignee && typeof updates.assignee === "string") {
    const assigneeUser = await User.findOne({
      username: (updates.assignee as string).toLowerCase(),
    });
    updates.assignee = assigneeUser ? assigneeUser._id : null;
  }

  // Stamped only when the assignee actually moves, and after it has been resolved to an id so the
  // comparison is between two of the same thing. The same call `agent` makes further down,
  // for the same client: a REST or MCP consumer that GETs a task, edits one field and PUTs the
  // whole object back would otherwise re-stamp itself as the assigner — which silently takes the
  // task out of what any machine may claim, with no error, no activity row, and a card that looks
  // exactly as it did.
  const before = oldTask.assignee as { _id?: unknown } | null | undefined;
  const storedAssignee = String((before && before._id) ?? before ?? "");

  // Only a MOVE is judged, never an echo of what is already stored. A REST or MCP client that GETs
  // a task, edits one field and PUTs the whole object back sends the assignee too — so judging
  // every incoming value would make a task assigned before that person lost access refuse every
  // unrelated edit anyone made to it afterwards. Unassigning is never refused: taking work away
  // from somebody who cannot reach the board is the repair, not the mistake.
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
    // Or when nothing is recorded yet, which is every task stored before BP-358. Without that
    // clause the documented repair — assign it again — is a no-op for the common legacy shape
    // (already assigned to you, no assigner), and the Agent row's "assign it again to record that"
    // becomes a lie.
    //
    // Narrowed to the actor putting the task in their OWN hands, because the repair is a person
    // taking on a task and there is nobody else it could be. Any other writer echoing the assignee
    // it just read — the PM agent, MCP under a second account, a REST client PUTting the whole
    // object — would otherwise stamp itself as the assigner of work it had nothing to do with,
    // which reads as a definite "somebody else handed you this" where the truth is "nobody knows",
    // and leaves the owner's own re-selection unable to change anything.
    const takesItOn = !oldTask.assignedBy && String(actorId) === String(updates.assignee ?? "");
    if (moved || takesItOn) {
      updates.assignedBy = actorId;
      // Written every time `assignedBy` is, so it can never outlive the hand-over it describes: a
      // person reassigning a task the PM once handed over clears it back to null.
      updates.pmAssignedFor = onWhoseInstruction;
    }
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
      const key = taskKeyOf(keyed?.key, oldTask.taskNumber);
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
  const setFields: Record<string, unknown> = releasesWorker
    ? { assignee: null, assignedBy: null, ...updates }
    : updates;

  // Same rule as `onlyOrder`, for the other way a write can not be an edit: an empty body leaves
  // `updatedAt` as the only field that moved, which is the one a caller reads as proof something
  // was written (BP-497). `leavesColumn` is checked because that arm writes through $unset alone.
  const writesNothing = Object.keys(setFields).length === 0 && !leavesColumn;

  // Who the task belongs to once this update lands. Read off `setFields` rather than off
  // `updates`, because a status change that leaves the active column while a run holds the task
  // blanks the assignee in that same write — so a forced release leaves the task belonging to
  // nobody, and nobody is not "assigned to you".
  const assigneeAfter = "assignee" in setFields ? setFields.assignee : storedAssignee;
  // The pair a claim requires is `assignee === assignedBy === the machine's owner`, so a write
  // changing EITHER half is the hand-over coming into being. The second half is not hypothetical:
  // the legacy repair the product itself prints — assign it to yourself again — does not move the
  // assignee, and stamping the assigner is what makes such a task claimable for the first time.
  const handsItOver =
    refId(assigneeAfter) !== storedAssignee || updates.assignedBy !== undefined;

  // BP-345 kept the choice to instance admins because it could arm a machine belonging to somebody
  // else. Since BP-358 a claim requires assignee === assignedBy === the machine's owner, so the
  // routing holds that boundary for the vetted agents and the choice belongs to whoever may edit
  // the task — which the route's project gate already answers. Which agents may run here at all is
  // a separate question, and still asked; null is exempt because choosing none names no agent.
  //
  // Judged against the assignee this update LEAVES, not the one it read: assignee and agent travel
  // in the same PUT, so reading the stored one would let `{ assignee: colleague, agent: mine }`
  // through on the strength of a pairing the write is about to end.
  if (updates.agent !== undefined && updates.agent !== null) {
    const usable = await agentUsableOnProject(projectId, updates.agent, actorId, assigneeAfter);
    if (!usable.ok) return { ok: false, error: usable.error, status: 400 };
  }

  // An agent is the hand-over, so handing the task to a different person is a NEW hand-over and
  // the agent that rode the old one has no standing on it. Only a personal one: a project agent
  // was authored by a project admin and a global one is shipped, so the incoming assignee could
  // have chosen either, and dropping them would lose a field on every ordinary reassignment.
  //
  // Only the agent already STORED. One named in this same request was judged against the assignee
  // this write leaves, immediately above, and re-clearing it would undo a valid choice.
  if (handsItOver && updates.agent === undefined && oldTask.agent) {
    if (await personalAgentAlienTo(oldTask.agent, assigneeAfter)) setFields.agent = null;
  }

  const task = await Task.findOneAndUpdate(
    { _id: taskId, project: projectId },
    // One `$set`, so nothing decided after `setFields` was built can reach one arm and not the other
    { $set: setFields, ...(leavesColumn ? { $unset: UNSET_RUN } : {}) },
    { returnDocument: "after", runValidators: true, timestamps: !onlyOrder && !writesNothing }
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
    // Through refId, not String(): `oldTask` is lean and holds a raw ObjectId while `task` comes
    // back with `agent` populated, and String() on a populated document is its inspect output —
    // so a plain comparison would log an agent change on every update that changed nothing.
    const oldVal = refId(oldTask[field as keyof typeof oldTask]);
    const newVal = refId(task[field as keyof typeof task]);
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

  // A watcher who was also mentioned used to get both, with the same excerpt in each. The
  // mention is the one that says why they were wanted, so it wins and the other skips them.
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

  // One successor per closed occurrence, whichever way the task got back into a done column —
  // dragged out of Done and back, or moved between two done-role columns. Before the counter is
  // incremented, so a refused mint burns no task number.
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
    // Inherited, not stamped with userId: userId is whoever/whatever closed this occurrence, which
    // may be the worker's own identity finishing its run, not the person who owns the series. The
    // next occurrence continues the same standing assignment, so it carries the same assigner.
    assignedBy: oldTask.assignedBy,
    // Carried for the same reason, and BP-358 is why it has to be: choosing an agent is the whole
    // of the hand-over now, so an occurrence created without one is a task no machine looks at. A
    // weekly task that had run autonomously for months would simply stop, and the card would look
    // entirely normal — no error, no empty field a person would notice.
    //
    // Not re-judged against `oldTask.assignee` below — a decision, not an oversight (BP-369). This
    // write has no actor, so there is nothing here to run `personalAgentAlienTo` on behalf of; an
    // earlier write already chose the pairing and the copy means to reproduce it exactly.
    // `CLEAR_WORKER_ASSIGNEE` above is the only other writer that could drift it without going
    // through `updateTask`, and it can't — see the comment on `RUN_RELEASES_ASSIGNEE`. What
    // re-judging here cannot reach is a pairing already stale before `personalAgentAlienTo`
    // existed; that keeps reproducing because closing an occurrence is not an edit to the one being
    // copied. `snapshotFor` still refuses to run a machine on a stale pairing at claim time, so
    // nothing unvetted executes — this is a one-off document repair, out of band: see
    // scripts/repair-recurring-agent-pairing.ts.
    agent: oldTask.agent ?? null,
    dueDate: nextDue,
    checklist,
    // Rebuilt rather than copied, so the anchor the arithmetic just resolved travels with the
    // series: without it every occurrence re-derives the day from the one before, and a single
    // February leaves a series on the 28th for good.
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

  // Read before the update, not after: the move clears an assignee the run put there, so afterwards
  // there is nobody left on the task to tell. A task out of attempts is rare, so this normally
  // costs one query that matches nothing.
  const abandoned = await Task.find(
    outOfAttempts,
    "taskNumber title assignee watchers execution.workerId"
  ).lean();

  // The attempt is not refunded: a task that repeatedly outlives its worker has to run out of
  // attempts and reach a human, rather than cycling through the queue forever
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

  // Only what this call actually moved: two workers polling at once both read the list, and the
  // one whose update matched nothing must not announce the other's work a second time.
  if (spent.modifiedCount > 0) {
    announceAbandonedRuns(projectId, project, abandoned, exhausted, columns).catch((err) =>
      console.error("Failed to announce an abandoned run:", err)
    );
  }

  return spent.modifiedCount + retryable.modifiedCount;
}

/**
 * A run reaching its attempt limit is the one thing on a board that happens with nobody watching:
 * the lease expires on a machine that is already gone, so the move has no actor and went through
 * updateMany, which fires no webhook and no notification.
 */
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
    // The machine that stopped answering is the actor, because that is what happened — and the
    // notification row needs one. Without its identity there is nothing truthful to put there.
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

  // Explicit about presence, not just format: isValid(null | undefined | "") already happens to
  // return false in this bson version, but that is the library's choice, not a guarantee — a
  // missing owner should not depend on it staying that way.
  if (!ownerId || !Types.ObjectId.isValid(ownerId)) return null;

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

  // Looked up rather than upserted: a poll must not be what creates the PM account on an instance
  // that has never run one, and an instance without it simply has no PM assignments to honour.
  const pm = await pmUserId();

  // The runId is the only caller-controlled string any `updatePipeline: true` write in this file
  // interpolates. The rest — including this one's own `activeStatus` — are column ids resolved from
  // the project's own board, and the one route that writes those slugifies to `[a-z0-9_]`: safe by
  // a validator elsewhere, so if that rule ever loosens they want `$literal` too (BP-329).
  return Task.findOneAndUpdate(
    {
      project: projectId,
      status: { $in: approved },
      // Assigned to the owner, by the owner or by the PM. A *person* assigning you work is still a
      // proposal, and the surface for accepting one does not exist yet — so it is refused rather
      // than run unattended. The PM is not somebody else: it is a first-party actor on this
      // instance, and BP-419 is the decision that its assignment is a real hand-over rather than a
      // proposal nothing could ever accept. What that rests on: an actor able to steer the PM can
      // queue work onto a machine unattended, and BP-321 (injected text replayed to the model as
      // system truth) is therefore a control on this, not a neighbouring bug.
      //
      // A task stored before BP-358 has no `assignedBy` key at all, and a missing field never
      // equals an ObjectId, so this refuses every one of them. That is the decision, not an
      // oversight, and there is deliberately no backfill: the field answers "did this person hand
      // this to themselves", the document does not record it, and the obvious guess —
      // assignedBy := assignee — silently converts work somebody else handed you into work you
      // handed yourself, for every task at once. Nothing is lost by refusing: a task also has to
      // name an agent to be claimable, and the ones that do were routed by the old project-wide
      // nominee, so they are assigned to that nominee rather than to any machine's owner and have
      // to be reassigned regardless — which stamps `assignedBy` through updateTask. The agent
      // picker says so on the task itself.
      assignee: ownerId,
      // Either the owner handed it to themselves, or the PM did it on the owner's own instruction.
      // The second clause is what keeps this narrow: the PM chat is reachable by any project
      // member, so without `pmAssignedFor` a member could ask the PM to assign a task they wrote to
      // a colleague, and that colleague's machine would run their text. An unattended turn records
      // nobody, so nothing it assigns is ever claimed.
      $and: [
        {
          $or: [
            { assignedBy: ownerId },
            ...(pm ? [{ assignedBy: pm, pmAssignedFor: ownerId }] : []),
          ],
        },
      ],
      // Choosing an agent is the hand-over; a task naming none is one a person is doing
      agent: { $ne: null },
      // On an array field this means "holds none of them", so a task with no blockers, one whose
      // blockers have all finished, and one written before the field existed all still qualify
      blockedBy: { $nin: openBlockers },
      // Mongoose applies defaults at hydration, so tasks created before the
      // execution subdocument existed have no such field — and $lt never
      // matches a missing one
      $or: [
        { "execution.attempts": { $exists: false } },
        { "execution.attempts": { $lt: MAX_EXECUTION_ATTEMPTS } },
      ],
    },
    [
      {
        $set: {
          status: activeStatus,
          // Neither `assignee` nor `assignedBy` is written: the filter above matched on both, so
          // the hand-over is already exactly what it should stay.
          //
          // Written false, not omitted: releasing reads `$ifNull` over this and treats a MISSING
          // value as "the claim assigned it", which would blank the person's own assignment on
          // the first release and drop the task out of what any machine may claim.
          "execution.assignedByRun": false,
          "execution.workerId": { $literal: workerId },
          // `$literal`, because an aggregation `$set` reads a leading `$` as a FIELD PATH and
          // Mongoose casts nothing in a pipeline update. Measured: `"$$REMOVE"` stored no runId at
          // all; `"$execution.workerId"` stored nothing on a first claim and the PREVIOUS run's
          // workerId on a later one, because a field path resolves against the document as it was
          // before the `$set` and a release deliberately leaves `workerId` behind. Either way the
          // task went active held by a run nothing could address until the lease expired (BP-329).
          "execution.runId": { $literal: runId },
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
