import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { PlannerClient } from "./planner-client";
import { resolveFieldsByName } from "@/lib/custom-fields";
import { COLUMN_ROLES, CUSTOM_FIELD_TYPES, DEPENDENCY_TYPES, OPTION_FIELD_TYPES, ROLE_LABELS } from "@/types";
import { MAX_OPTIONS } from "@/lib/custom-fields";
import { APP_NAME } from "@/lib/brand";
import { echo } from "@/lib/echo";
import {
  strictInput,
  NOTHING_TO_CHANGE,
  CREATE_TASK_HINTS,
  UPDATE_TASK_HINTS,
  CHANGE_STATUS_HINTS,
  taskIdsInOrder,
} from "./strict-input";
import { MAX_REORDER_IDS } from "@/lib/reorder";
import { taskSummary, withTaskKeys, describeLink } from "./task-shape";
import { findSprint, incompleteDestination, sprintSummary, type SprintRow } from "./sprints";
import { listedTask, sprintNeedsLookup, sprintParam } from "./task-list";
import {
  DUE_DATE_PARAM,
  RECURRENCE_PARAM,
  SPRINT_PARAM,
  dueDateValue,
  recurrenceValue,
  sprintClears,
  sprintForWrite,
} from "./task-fields";
import { findItem, mergeCriteria, shownCriteria, type Criterion } from "./checklist-edit";
import { agentLines, memberLines, myTaskLines } from "./people";
import { noticeLines, runLines, searchLines, statsSummary } from "./discovery";
import { activityLines, commentLines } from "./history";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, pageOf } from "./paging";
import {
  ADD_ONLY,
  COLOUR_PARAM,
  columnSummary,
  fieldSummary,
  findColumn,
  findField,
  optionLines,
  requireOwner,
} from "./board-config";
import { syncProvider, syncSummary } from "./sync-repository";
import { effectiveColumns } from "@/lib/columns";
import { BATCH_LIMIT, LINK_BATCH_LIMIT, MAX_BLOCKERS_PER_ITEM, failure, referencedKey } from "./batch";

type ToolExtra = { authInfo?: AuthInfo; signal?: AbortSignal };

// One client per call, so the lookups a batch repeats for every item — the board list, a roster, the
// sprints — are made once. `extra` is made per request by the SDK, so the client does not outlive its call.
const clients = new WeakMap<object, PlannerClient>();

export function clientFrom(extra: ToolExtra): PlannerClient {
  const auth = extra.authInfo;
  if (!auth) throw new Error("Unauthorized");
  const baseUrl = auth.extra?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error("Missing base URL in auth context");
  }
  let client = clients.get(extra);
  if (!client) {
    client = new PlannerClient(baseUrl, auth.token);
    clients.set(extra, client);
  }
  return client;
}

const MINIMAL_PARAM = z
  .boolean()
  .optional()
  .describe(
    "Answer with just the key, title, status, priority, assignee and a link instead of the whole " +
      "task. Use it when writing many tasks: the full answer is mostly ids you will not read."
  );

/** `CP` of `CP-12`, `MY-APP` of `MY-APP-3`: a project key may itself hold hyphens. */
const keyPrefix = (taskKey: string) => taskKey.slice(0, taskKey.lastIndexOf("-")).toUpperCase();

/** The same task named twice: the project prefix in any case, and `CP-007` is `CP-7`. */
function sameTaskKey(a: string, b: string) {
  const parts = (key: string) => key.trim().match(/^(.+)-(\d+)$/);
  const left = parts(a);
  const right = parts(b);
  return !!left && !!right && left[1].toUpperCase() === right[1].toUpperCase() && Number(left[2]) === Number(right[2]);
}

/** Keyed from the stored number, not the argument: `cp-007` is `CP-7`. */
function summarised(client: PlannerClient, task: { taskNumber?: number }, taskKey: string) {
  const canonical = `${keyPrefix(taskKey)}-${task.taskNumber}`;
  return taskSummary(task as Parameters<typeof taskSummary>[0], canonical, client.taskUrl(canonical));
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerPlannerTools(server: McpServer): void {
  // The handlers the batch tools call: the same code the single tools run, not a second copy of it
  type Handler = (args: Record<string, unknown>, extra: ToolExtra) => Promise<{ content: { text: string }[] }>;
  const handlers: Record<string, Handler> = {};
  const register: McpServer["registerTool"] = (name, config, handler) => {
    handlers[name] = handler as unknown as Handler;
    return server.registerTool(name, config as never, handler as never) as never;
  };

  // --- Projects ---

  server.registerTool(
    "list_projects",
    {
      description: `List all projects in ${APP_NAME}`,
      inputSchema: strictInput({}),
    },
    async (_args, extra) => {
      return json(await clientFrom(extra).listProjects());
    }
  );

  server.registerTool(
    "get_project",
    {
      description: "Get project details by project key (e.g. 'CP') or project ID",
      inputSchema: strictInput({ identifier: z.string().describe("Project key (e.g. 'CP') or project ID") }),
    },
    async ({ identifier }, extra) => {
      const client = clientFrom(extra);
      let project: unknown;
      try {
        project = await client.getProject(identifier);
      } catch {
        project = await client.getProjectByKey(identifier);
      }
      return json(project);
    }
  );

  // --- People and agents ---

  server.registerTool(
    "list_members",
    {
      description:
        "The people a board can hand work to, by the username assignee takes. Only people with access to the " +
        "board: a name that is not here is refused as an assignee, which is how a typo and somebody without " +
        "access are deliberately not told apart.",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(memberLines((await client.listAssignableUsers(proj._id)) as { username: string }[]));
    }
  );

  server.registerTool(
    "whoami",
    {
      description: "The account this connection acts as: its username, name and role. Use it for \"assign to me\".",
      inputSchema: strictInput({}),
    },
    async (_args, extra) => {
      const me = await clientFrom(extra).getMe();
      return json({ username: me.username, fullName: me.fullName ?? "", role: me.role ?? "member" });
    }
  );

  server.registerTool(
    "my_tasks",
    {
      description:
        "The caller's own tasks across every board, most recently changed first, a page at a time. Finished " +
        "work (a column with the done role) is left out unless includeDone. The answer says the total and the " +
        "offset of the next page.",
      inputSchema: strictInput({
        includeDone: z.boolean().optional().describe("Also the tasks in a done column (default: not)"),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Page size (default ${DEFAULT_LIST_LIMIT})`),
        offset: z.number().int().min(0).optional().describe("Tasks to skip, from a previous answer's nextOffset"),
      }),
    },
    async ({ includeDone, limit, offset }, extra) => {
      const tasks = (await clientFrom(extra).listMyTasks()) as Parameters<typeof myTaskLines>[0];
      return json(
        myTaskLines(tasks, { includeDone: includeDone ?? false, limit: limit ?? DEFAULT_LIST_LIMIT, offset: offset ?? 0 })
      );
    }
  );

  server.registerTool(
    "list_agents",
    {
      description:
        "The agents update_task can hand a task to on this board, by name: the board's own, the caller's personal " +
        "ones and the global ones. `steps` is how many steps each runs — an agent with none is refused, and a " +
        "personal agent only runs a task assigned to its owner.",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(agentLines((await client.listAgents()) as Parameters<typeof agentLines>[0], proj._id));
    }
  );

  // --- Looking around ---

  server.registerTool(
    "search_tasks",
    {
      description:
        "Find tasks across every board the caller can reach, which list_tasks (one board) cannot. A task key such as " +
        "CP-12 finds that task; anything else matches text in the title or description, newest first, at most 50.",
      inputSchema: strictInput({ query: z.string().min(2).describe("A task key, or at least two characters of text") }),
    },
    async ({ query }, extra) => {
      const found = (await clientFrom(extra).searchTasks(query)) as Parameters<typeof searchLines>[0];
      // The route stops at 50 text hits, so a full answer may be the first page of more
      return json({ returned: found.length, truncated: found.length >= 50, tasks: searchLines(found) });
    }
  );

  server.registerTool(
    "get_project_stats",
    {
      description:
        "A board's numbers: how many tasks and how many are finished (by the board's own done columns), the " +
        "breakdown by status, category, assignee and difficulty, and the last weeks' created and completed counts.",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(statsSummary(await client.getProjectStats(proj._id)));
    }
  );

  server.registerTool(
    "list_runs",
    {
      description:
        "The runs workers have made on a board, newest first: the task, the agent, how each ended (and what refused it), " +
        "minutes and cost. For a board's admins, as in the app: the detail of a run can carry gate output.",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        limit: z.number().int().min(1).max(100).optional().describe("Runs to return (default 20)"),
      }),
    },
    async ({ project, limit }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      // The app shows run history only to a board's admins (Settings → Workers); the route would answer any member
      if (!proj.canAdmin) {
        throw new Error(`Run history is for the admins of ${echo(project.toUpperCase())}, as in the app. Nothing was read.`);
      }
      return json(runLines((await client.listRuns(proj._id, limit ?? 20)) as Parameters<typeof runLines>[0]));
    }
  );

  server.registerTool(
    "list_notifications",
    {
      description:
        "The caller's own notifications, newest first: what happened, on which task, by whom, and whether it is read. " +
        "A full page carries nextBefore; pass it back as `before` for the older ones.",
      inputSchema: strictInput({
        limit: z.number().int().min(1).max(100).optional().describe("Notifications to return (default 30)"),
        before: z
          .string()
          .refine((value) => !Number.isNaN(Date.parse(value)), "a timestamp, as nextBefore gives")
          .optional()
          .describe("A nextBefore from a previous answer"),
      }),
    },
    async ({ limit, before }, extra) => {
      const asked = limit ?? 30;
      const rows = (await clientFrom(extra).listNotifications(asked, before)) as Parameters<typeof noticeLines>[0];
      return json(noticeLines(rows, asked));
    }
  );

  server.registerTool(
    "mark_notifications_read",
    {
      description:
        "Mark one notification read by its id, or — with no id — every notification the list shows: a connection " +
        "limited to some boards clears only those boards'. Anything else about a notification is left alone.",
      inputSchema: strictInput(
        { id: z.string().optional().describe("A notification's id, from list_notifications; leave out for all") },
        { writes: true }
      ),
    },
    async ({ id }, extra) => {
      await clientFrom(extra).markNotificationsRead(id);
      return json({ read: id ?? "all" });
    }
  );

  // --- Tasks ---

  server.registerTool(
    "list_tasks",
    {
      description:
        `List tasks in a project with optional filters, one page at a time (default ${DEFAULT_LIST_LIMIT}, at most ` +
        `${MAX_LIST_LIMIT}). The answer says the total the filters match and the offset of the next page; ` +
        "follow nextOffset until it is null to read the rest. Each task is a short line — key, title, status, " +
        "priority, assignee, dueDate, sprint name and parent key, and for an epic how many of its children are done — " +
        "unless detail is \"full\"; get_task reads one in full.",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        // The same lie the category description carried, and a worse one: columns have been
        // project-defined since CP-128, so an agent on a renamed board asked for `todo` and was
        // answered an empty list it reported as "nothing to do" (BP-511).
        status: z
          .string()
          .optional()
          .describe(
            "Filter by status (comma-separated): the project's column ids — get_project lists them (defaults: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done)"
          ),
        assignee: z.string().optional().describe("Filter by assignee username"),
        // Project-defined, and since BP-502 an unknown one is refused rather than silently matched
        // — so a description naming the seeded four as closed would *produce* 400s on a board that
        // renamed them. The sibling package already words it this way.
        category: z
          .string()
          .optional()
          .describe("Filter by category (project-defined; defaults: bug, doc, user-story, idea)"),
        priority: z.string().optional().describe("Filter by priority: low, medium, high, urgent"),
        sprint: z
          .string()
          .optional()
          .describe("Filter by sprint name (or id), or \"backlog\" for tasks in no sprint"),
        search: z.string().optional().describe("Text in the title or description, case-insensitive"),
        parent: z
          .string()
          .optional()
          .describe("Only the children of this task (its parent_of links), by key — the epic's key lists the epic's tasks"),
        dueBefore: z.string().optional().describe("Due on or before this day (YYYY-MM-DD); tasks with no due date are left out"),
        dueAfter: z.string().optional().describe("Due on or after this day (YYYY-MM-DD); tasks with no due date are left out"),
        updatedSince: z.string().optional().describe("Changed since this day or ISO timestamp"),
        blocked: z
          .boolean()
          .optional()
          .describe("true: only tasks with at least one blocked_by link; false: only tasks with none"),
        hasChildren: z
          .boolean()
          .optional()
          .describe("true: only tasks that have children — the epics, each with how many of its children are done; false: only tasks with none"),
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Filter by project-defined fields, keyed by field name, e.g. { \"Difficulty\": \"L\" } — all must match. " +
              "Dropdown, multiselect, text (containing, any case), number and checkbox fields; get_project lists them. " +
              "A multiselect given several options needs all of them."
          ),
        archived: z
          .enum(["only", "include"])
          .optional()
          .describe(
            "Archived tasks are left out unless asked for: only lists just the archived ones, include lists them " +
              "with the rest (each marked archived: true)"
          ),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Page size (default ${DEFAULT_LIST_LIMIT})`),
        offset: z.number().int().min(0).optional().describe("Tasks to skip, from a previous answer's nextOffset"),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("summary (default): one short line per task. full: each task's whole stored body, which is large"),
      }),
    },
    async (
      { project, status, assignee, category, priority, sprint, search, parent, dueBefore, dueAfter, updatedSince, blocked, hasChildren, fields, archived, limit, offset, detail },
      extra
    ) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (assignee) filters.assignee = assignee;
      if (category) filters.category = category;
      if (priority) filters.priority = priority;
      if (search) filters.search = search;
      if (dueBefore) filters.dueBefore = dueBefore;
      if (dueAfter) filters.dueAfter = dueAfter;
      if (updatedSince) filters.updatedSince = updatedSince;
      if (blocked !== undefined) filters.blocked = String(blocked);
      if (archived) filters.archived = archived;
      if (hasChildren !== undefined) filters.hasChildren = String(hasChildren);

      if (sprint) {
        const sprints = sprintNeedsLookup(sprint)
          ? ((await client.listSprints(proj._id)) as { _id: string; name: string }[])
          : [];
        filters.sprint = sprintParam(sprint, sprints);
      }

      if (parent) {
        const end = await client.resolveTaskKey(parent);
        if (end.projectId !== proj._id) {
          throw new Error(`${echo(parent.toUpperCase())} is not on ${echo(project.toUpperCase())}, so it has no children here.`);
        }
        filters.parent = end.taskId;
      }

      const fieldFilters: string[] = [];
      if (fields && Object.keys(fields).length) {
        // The resolver reads any checkbox value that is not true as false; as a filter that would
        // quietly ask for the unticked tasks, so a checkbox is held to true or false
        for (const [name, value] of Object.entries(fields)) {
          const def = (proj.customFields || []).find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
          if (def?.fieldType === "checkbox" && ![true, false, "true", "false"].includes(value as never)) {
            throw new Error(`"${echo(name)}" is a checkbox: filter on true or false`);
          }
        }
        const resolved = resolveFieldsByName(fields, proj.customFields || []);
        for (const [fieldId, value] of Object.entries(resolved)) {
          for (const one of Array.isArray(value) ? value : [value]) fieldFilters.push(`${fieldId}:${String(one)}`);
        }
      }

      const pageSize = limit ?? DEFAULT_LIST_LIMIT;
      const start = offset ?? 0;
      const page = await client.pageTasks(
        proj._id,
        { ...filters, limit: String(pageSize), offset: String(start), ...(detail === "full" ? {} : { view: "summary" }) },
        fieldFilters
      );
      const shown =
        detail === "full"
          ? page.tasks
          : (page.tasks as Parameters<typeof listedTask>[0][]).map((row) => listedTask(row, project.toUpperCase()));
      return json(pageOf(shown, page.total, page.offset));
    }
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Get full task details by task key (e.g. 'CP-1'). An epic — a task with children — also answers children " +
        "(key, title, status) and progress: how many of them are done (total, done, byStatus), done being the board's done column.",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }),
    },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const task = (await client.getTask(projectId, taskId)) as Record<string, unknown>;
      return json(withTaskKeys(task, keyPrefix(taskKey)));
    }
  );

  server.registerTool(
    "archive_task",
    {
      description:
        "Archive a task: it leaves the board, every list, search, my_tasks and the counts (the PM agent's lists " +
        "too, though the PM agent can still open it by its key), and no worker will claim it, but it keeps its " +
        "comments and history and can be restored with unarchive_task. An archived blocker no longer holds back the " +
        "tasks it blocked. Any member of the board may archive. Refused while a worker is running the task. " +
        "list_tasks with archived finds archived tasks; get_task and every key-addressed tool still reach one by its key.",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }, { writes: true }),
    },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const task = (await client.archiveTask(projectId, taskId)) as { taskNumber?: number };
      return json({ archived: true, ...summarised(client, task, taskKey) });
    }
  );

  server.registerTool(
    "unarchive_task",
    {
      description:
        "Restore an archived task to the board, in the column it was archived from. It holds back the tasks it " +
        "blocks again while it is not done. Any member of the board may.",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }, { writes: true }),
    },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const task = (await client.unarchiveTask(projectId, taskId)) as { taskNumber?: number };
      return json({ archived: false, ...summarised(client, task, taskKey) });
    }
  );

  server.registerTool(
    "delete_task",
    {
      description:
        "Delete a task for good, with its comments, history and notifications. It cannot be undone, so unless the " +
        "task is truly unwanted use archive_task. Only the board's owner may delete; a member who is not the owner " +
        "can only archive. confirmKey has to repeat taskKey, which guards against a slip of the hand, not against naming the wrong task: both come from the caller. " +
        "Refused, and never forced, while a worker is running the task.",
      inputSchema: strictInput(
        {
          taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
          confirmKey: z.string().describe("The task's key again (the project prefix may be in any case), to confirm"),
        },
        { writes: true }
      ),
    },
    async ({ taskKey, confirmKey }, extra) => {
      if (!sameTaskKey(taskKey, confirmKey)) {
        throw new Error(
          `Not deleted: confirmKey "${echo(confirmKey)}" is not the key of the task to delete, "${echo(taskKey)}". Nothing was written.`
        );
      }
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      if (!(await client.getProject(projectId)).canAdmin) {
        throw new Error(
          `Not deleted: only the board's owner may delete a task, and this connection is not the owner's. ` +
            `Use archive_task for ${echo(taskKey.toUpperCase())} instead. Nothing was written.`
        );
      }
      await client.deleteTask(projectId, taskId);
      return json({ deleted: taskKey.toUpperCase() });
    }
  );

  // The fields of a task as create_task takes them — and as each item of create_tasks does, so the two cannot drift
  const CREATE_SHAPE = {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        priority: z.string().optional().describe("Priority: low, medium, high, or urgent (default: medium)"),
        category: z.string().optional().describe("Category — one of the project's configured categories (defaults: bug, doc, user-story, idea)"),
        assignee: z
          .string()
          .optional()
          .describe(
            "Assignee username. A new task never names an agent — hand it to a machine with " +
              "update_task once it exists."
          ),
        status: z.string().optional().describe("Initial status — one of the project's column ids, get_project lists them (default: the board's first backlog column)"),
        acceptanceCriteria: z
          .string()
          .optional()
          .describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
        dueDate: DUE_DATE_PARAM,
        sprint: SPRINT_PARAM,
        recurrence: RECURRENCE_PARAM,
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name, e.g. { \"Owoce\": \"Apples\" }. " +
              "get_project lists this project's fields and the options each one accepts."
          ),
  };

  register(
    "create_task",
    {
      description: "Create a new task in a project",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        ...CREATE_SHAPE,
        minimal: MINIMAL_PARAM,
      }, { hints: CREATE_TASK_HINTS, writes: true }),
    },
    async (
      { project, title, description, priority, category, assignee, status, acceptanceCriteria, minimal, dueDate, sprint, recurrence, fields },
      extra
    ) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const data: Record<string, unknown> = { title };

      if (description) data.description = description;
      if (priority) data.priority = priority;
      if (category) data.category = category;
      if (status) data.status = status;
      if (acceptanceCriteria) data.acceptanceCriteria = acceptanceCriteria;
      if (dueDate) data.dueDate = dueDateValue(dueDate);
      if (recurrence) data.recurrence = recurrenceValue(recurrence);
      if (sprint && !sprintClears(sprint)) {
        data.sprint = sprintForWrite(sprint, (await client.listSprints(proj._id)) as SprintRow[]);
      }
      if (fields && Object.keys(fields).length) {
        data.customFieldValues = resolveFieldsByName(fields, proj.customFields || []);
      }

      if (assignee) {
        // Scoped to the board, not the instance. A username that is not on this list may be a typo
        // or somebody with no access, and the two are deliberately NOT told apart: doing so would
        // mean answering "does this account exist elsewhere", which is the instance-wide roster
        // BP-400 removed.
        const users = (await client.listAssignableUsers(proj._id)) as { username: string }[];
        const user = users.find((u) => u.username === assignee.toLowerCase());
        if (!user) {
          throw new Error(
            `"${echo(assignee)}" is not someone this board can be assigned to — only people with access to it are.`
          );
        }
        data.assignee = user.username;
      }

      const created = (await client.createTask(proj._id, data)) as { taskNumber: number };
      return json(minimal ? summarised(client, created, `${project.toUpperCase()}-${created.taskNumber}`) : created);
    }
  );

  const UPDATE_SHAPE = {
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.string().optional().describe("Priority: low, medium, high, or urgent"),
        category: z.string().optional(),
        assignee: z.string().optional().describe("Assignee username. Empty string to unassign."),
        agent: z
          .string()
          .optional()
          .describe(
            "Which agent runs this task on a machine, by name. Choosing one is the hand-over: the " +
              "machine belonging to the task's assignee takes it and runs that agent, and only when " +
              "that person assigned it to themselves. Empty string means nobody — the default, and " +
              "what a task somebody is doing by hand looks like. A project agent may be chosen by " +
              "anyone who can edit the task; a personal agent only by its owner, and only onto their " +
              "own task (refused otherwise, dropped again when the task is handed on); a global " +
              "agent isn't scoped to either, so the same anyone-who-can-edit-the-task rule covers " +
              "it too; an agent with no steps is refused."
          ),
        acceptanceCriteria: z
          .string()
          .optional()
          .describe(
            "The whole checklist as markdown lines. A line whose text is unchanged keeps its id and its tick; a plain " +
              "line leaves the tick as it was, and \"- [ ]\" / \"- [x]\" sets it. To change one criterion use " +
              "set_checklist_item, add_checklist_item or remove_checklist_item."
          ),
        dueDate: DUE_DATE_PARAM,
        sprint: SPRINT_PARAM,
        recurrence: RECURRENCE_PARAM,
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name. Only the named fields change; " +
              "the task's other field values are left alone. get_project lists them."
          ),
  };

  register(
    "update_task",
    {
      description: "Update an existing task's fields by task key",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        ...UPDATE_SHAPE,
        minimal: MINIMAL_PARAM,
      }, { hints: UPDATE_TASK_HINTS, writes: true }),
    },
    async (
      { taskKey, title, description, priority, category, assignee, agent, acceptanceCriteria, minimal, dueDate, sprint, recurrence, fields },
      extra
    ) => {
      // Before the lookup, so a call that changes nothing costs nothing and the refusal is the
      // first thing that happens rather than the last
      if (
        ![title, description, priority, category, assignee, agent, acceptanceCriteria, dueDate, sprint, recurrence].some(
          (v) => v !== undefined
        ) &&
        !Object.keys(fields || {}).length
      ) {
        throw new Error(`update_task ${NOTHING_TO_CHANGE}`);
      }

      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const data: Record<string, unknown> = {};

      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (category !== undefined) data.category = category;
      // Read once, for whichever of the two needs what the task holds now
      const held =
        acceptanceCriteria !== undefined || (fields && Object.keys(fields).length)
          ? ((await client.getTask(projectId, taskId)) as { checklist?: Criterion[]; customFieldValues?: Record<string, unknown> })
          : null;
      if (acceptanceCriteria !== undefined) data.checklist = mergeCriteria(acceptanceCriteria, held?.checklist ?? []);
      if (dueDate !== undefined) data.dueDate = dueDateValue(dueDate);
      if (recurrence !== undefined) data.recurrence = recurrenceValue(recurrence);
      if (sprint !== undefined) {
        data.sprint = sprintClears(sprint)
          ? null
          : sprintForWrite(sprint, (await client.listSprints(projectId)) as SprintRow[]);
      }

      if (fields && Object.keys(fields).length) {
        // customFieldValues is replaced wholesale by the API, so naming one field
        // would otherwise clear every other value on the task
        const project = await client.getProject(projectId);
        data.customFieldValues = {
          ...(held?.customFieldValues || {}),
          ...resolveFieldsByName(fields, project.customFields || []),
        };
      }

      if (assignee !== undefined) {
        if (assignee) {
          // See create_task: the roster is the board's, and a miss is not split into typo vs no-access.
          const users = (await client.listAssignableUsers(projectId)) as { username: string }[];
          const user = users.find((u) => u.username === assignee.toLowerCase());
          if (!user) {
            throw new Error(
              `"${echo(assignee)}" is not someone this board can be assigned to — only people with access to it are.`
            );
          }
          data.assignee = user.username;
        } else {
          data.assignee = null;
        }
      }

      // Resolved by name here rather than asking a caller for an ObjectId, the same way assignee
      // is: the id appears in no MCP response, so demanding one would make the parameter
      // unreachable from a conversation.
      if (agent !== undefined) {
        if (agent) {
          const agents = (await client.listAgents()) as
            { _id: string; name: string; scope: string; projectId: string | null }[];
          // Scoped to this task's own project, the same predicate the browser's picker filters by
          // (PropertyRail.tsx) — otherwise a name belonging to another board either steals that
          // board's agent silently (two boards sharing a name) or reaches the write only to be
          // refused by `agentUsableOnProject`, a 400 naming a rule the caller cannot see.
          const named = agents.filter((a) => a.name.toLowerCase() === agent.toLowerCase());
          const match = named.find((a) => a.scope !== "project" || a.projectId === projectId);
          if (!match) {
            throw new Error(
              named.length > 0
                ? `Agent "${agent}" exists on another project — only this project's own agents can be assigned here.`
                : `Agent "${echo(agent)}" not found`
            );
          }
          data.agent = match._id;
        } else {
          data.agent = null;
        }
      }

      // Backstop for a call that named `fields` but no field in it. The refusal above catches
      // everything else, before the lookup
      if (Object.keys(data).length === 0) throw new Error(`update_task ${NOTHING_TO_CHANGE}`);

      const updated = await client.updateTask(projectId, taskId, data);
      return json(minimal ? summarised(client, updated as { taskNumber?: number }, taskKey) : updated);
    }
  );

  // The route is told the state wanted and sets it in one update, so a retry — or two calls at once —
  // ends where the first one did.
  for (const [name, want] of [["watch_task", true], ["unwatch_task", false]] as const) {
    server.registerTool(
      name,
      {
        description: want
          ? "Watch a task as the caller, so its changes reach you. Safe to repeat: watching a task already watched changes nothing."
          : "Stop watching a task as the caller. Safe to repeat: a task not watched stays unwatched.",
        inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }, { writes: true }),
      },
      async ({ taskKey }, extra) => {
        const client = clientFrom(extra);
        const { projectId, taskId } = await client.resolveTaskKey(taskKey);
        const { watching } = await client.setWatching(projectId, taskId, want);
        return json({ taskKey: taskKey.toUpperCase(), watching });
      }
    );
  }

  // --- Checklist ---

  // Each tool changes one criterion in one update, by its id, on the server: a tick or an edit
  // landing from somewhere else while a call is in flight is not overwritten. The read below is only
  // to turn a text into the id.
  async function criterionOf(extra: ToolExtra, taskKey: string, ref: string) {
    const client = clientFrom(extra);
    const { projectId, taskId } = await client.resolveTaskKey(taskKey);
    const held = ((await client.getTask(projectId, taskId)) as { checklist?: Criterion[] }).checklist ?? [];
    return { client, projectId, taskId, itemId: String(held[findItem(held, ref)]._id) };
  }

  const checklistAnswer = (taskKey: string, stored: { checklist?: Criterion[] }) =>
    json({ taskKey: taskKey.toUpperCase(), checklist: shownCriteria(stored.checklist ?? []) });

  const ITEM_PARAM = z
    .string()
    .describe("The criterion: its id (get_task and these tools list them) or its exact text");

  server.registerTool(
    "add_checklist_item",
    {
      description:
        "Add one acceptance criterion to the end of a task's checklist, in one update that leaves the others alone — " +
        "update_task's acceptanceCriteria rewrites the whole list. Answers with the checklist and each item's id.",
      inputSchema: strictInput(
        {
          taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
          text: z.string().describe("The criterion"),
          done: z.boolean().optional().describe("Already done (default: not)"),
        },
        { writes: true }
      ),
    },
    async ({ taskKey, text, done }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return checklistAnswer(taskKey, await client.addChecklistItem(projectId, taskId, { text, done: done ?? false }));
    }
  );

  server.registerTool(
    "set_checklist_item",
    {
      description:
        "Change one acceptance criterion in one update: tick or untick it (done), or reword it (text). The rest of the " +
        "list is not touched. Answers with the checklist and each item's id.",
      inputSchema: strictInput(
        {
          taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
          item: ITEM_PARAM,
          text: z.string().optional().describe("The new wording"),
          done: z.boolean().optional().describe("true to tick it, false to untick it"),
        },
        { writes: true }
      ),
    },
    async ({ taskKey, item, text, done }, extra) => {
      if (text === undefined && done === undefined) throw new Error(`set_checklist_item ${NOTHING_TO_CHANGE}`);
      const { client, projectId, taskId, itemId } = await criterionOf(extra, taskKey, item);
      return checklistAnswer(
        taskKey,
        await client.setChecklistItem(projectId, taskId, itemId, {
          ...(text !== undefined ? { text } : {}),
          ...(done !== undefined ? { done } : {}),
        })
      );
    }
  );

  server.registerTool(
    "remove_checklist_item",
    {
      description:
        "Remove one acceptance criterion in one update, leaving the rest of the list alone. Answers with the checklist and each item's id.",
      inputSchema: strictInput(
        { taskKey: z.string().describe("Task key (e.g. 'CP-1')"), item: ITEM_PARAM },
        { writes: true }
      ),
    },
    async ({ taskKey, item }, extra) => {
      const { client, projectId, taskId, itemId } = await criterionOf(extra, taskKey, item);
      return checklistAnswer(taskKey, await client.removeChecklistItem(projectId, taskId, itemId));
    }
  );

  server.registerTool(
    "change_task_status",
    {
      description: "Change the status of a task. Statuses are the project's column ids (defaults: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done — see get_project for the actual list with roles)",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        status: z.string().describe("New status"),
        minimal: MINIMAL_PARAM,
      }, { hints: CHANGE_STATUS_HINTS, writes: true }),
    },
    async ({ taskKey, status, minimal }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const changed = await client.changeTaskStatus(projectId, taskId, status);
      return json(minimal ? summarised(client, changed as { taskNumber?: number }, taskKey) : changed);
    }
  );

  server.registerTool(
    "reorder_tasks",
    {
      description:
        "Put tasks in the order given, the way dragging cards on the board does. The listed tasks " +
        "take, in the order listed, the positions they already hold among the project's tasks; " +
        "every task not listed keeps its place, and no status changes. Listing a column's cards top " +
        "to bottom orders that column. Each key at most once, all from this project — an unknown " +
        "key or one from another board refuses the whole call and nothing is reordered.",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        taskKeys: z
          .array(z.string())
          .min(1)
          .max(MAX_REORDER_IDS)
          .describe("Task keys in the order they should appear, first on top (e.g. ['CP-7', 'CP-3'])"),
      }, { writes: true }),
    },
    async ({ project, taskKeys }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const tasks = (await client.listTasks(proj._id)) as { _id: string; taskNumber: number }[];
      return json(await client.reorderTasks(proj._id, taskIdsInOrder(project, taskKeys, tasks)));
    }
  );

  // --- Links ---

  // The route scopes the far end to the same project — it looks the second task up by
  // `{ _id, project }` — so a cross-board link answers "Task not found", which reads as a mistyped
  // key. Resolving both keys here lets the refusal name the rule that actually refused.
  async function bothEnds(client: PlannerClient, taskKey: string, targetTaskKey: string) {
    const [from, to] = await Promise.all([
      client.resolveTaskKey(taskKey),
      client.resolveTaskKey(targetTaskKey),
    ]);
    if (from.projectId !== to.projectId) {
      throw new Error(
        `${echo(taskKey.toUpperCase())} and ${echo(targetTaskKey.toUpperCase())} are on different boards, and a link is only stored within one.`
      );
    }
    return { projectId: from.projectId, taskId: from.taskId, targetTaskId: to.taskId };
  }

  type LinkedTask = { _id?: string };
  type TaskEnds = {
    blockedBy?: LinkedTask[];
    blocking?: LinkedTask[];
    relations?: { task?: LinkedTask; type?: string }[];
    relatedFrom?: { task?: LinkedTask; type?: string }[];
  };

  // The route's DELETE is a `$pull` on one document and answers "Dependency removed" whenever that
  // document exists, so a type or an end the task does not hold is indistinguishable from a real
  // removal. Reading the ends first is what makes the answer mean something — and the far end is
  // read too, because naming the wrong one is the mistake this shape invites.
  function endHolding(task: TaskEnds, targetTaskId: string, type: string): "near" | "far" | "none" {
    const holds = (entries: { task?: LinkedTask; type?: string }[] | undefined) =>
      (entries ?? []).some((r) => String(r.task?._id ?? "") === targetTaskId && r.type === type);
    const listed = (tasks: LinkedTask[] | undefined) =>
      (tasks ?? []).some((t) => String(t?._id ?? "") === targetTaskId);

    if (type === "blocked_by") {
      if (listed(task.blockedBy)) return "near";
      return listed(task.blocking) ? "far" : "none";
    }
    if (holds(task.relations)) return "near";
    return holds(task.relatedFrom) ? "far" : "none";
  }

  const LINK_DIRECTION =
    "`type` reads from taskKey's side: blocked_by means taskKey is blocked by targetTaskKey; " +
    "parent_of means taskKey is the parent and targetTaskKey the child, which is how an epic gets " +
    "sub-tasks instead of a checklist; duplicates means taskKey is the duplicate of targetTaskKey, " +
    "and the two ends read differently — the far task's page says Duplicated by and offers no way " +
    "to remove it. Only relates means the same read either way, and even that is stored on one " +
    "end, so which task you name decides which end unlink_tasks can take it off again.";

  const LINK_TYPE_PARAM = "Which kind of link, read from taskKey's side — see the description.";

  register(
    "link_tasks",
    {
      description:
        "Link two tasks on the same board. " +
        LINK_DIRECTION +
        " The link is written on taskKey's side: a second call replaces the relates/duplicates/" +
        "parent_of link that end holds, while blocked_by is stored separately and stacks with it. " +
        "The far end keeps whatever it stored about taskKey, so linking a pair from both sides " +
        "leaves the board holding both. parent_of is the exception, because a task has one parent: " +
        "it is the CHILD that moves, and its previous parent loses it without being named in the " +
        "call. Cycles are refused for parent_of and blocked_by, the two types that carry an " +
        "ordering; relates and duplicates have no ordering to close. get_task reads the links " +
        "back, each linked task with its key, and parent and children read parent_of from both ends.",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        targetTaskKey: z.string().describe("The task at the other end (e.g. 'CP-2')"),
        type: z.enum(DEPENDENCY_TYPES).describe(LINK_TYPE_PARAM),
      }, { writes: true }),
    },
    async ({ taskKey, targetTaskKey, type }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId, targetTaskId } = await bothEnds(client, taskKey, targetTaskKey);
      await client.addTaskLink(projectId, taskId, targetTaskId, type);
      return json(describeLink(type, taskKey, targetTaskKey, false));
    }
  );

  server.registerTool(
    "unlink_tasks",
    {
      description:
        "Remove a link between two tasks. " +
        LINK_DIRECTION +
        " It removes the link stored on taskKey's side, so the " +
        "arguments have to name the end that holds it and the type it holds — get_task lists " +
        "both. A call that names a link this end does not hold is refused rather than answered " +
        "as a removal, and says which end holds it instead — so removing the same link twice " +
        "refuses the second time rather than passing quietly.",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        targetTaskKey: z.string().describe("The task at the other end (e.g. 'CP-2')"),
        type: z.enum(DEPENDENCY_TYPES).describe(LINK_TYPE_PARAM),
      }, { writes: true }),
    },
    async ({ taskKey, targetTaskKey, type }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId, targetTaskId } = await bothEnds(client, taskKey, targetTaskKey);

      const near = echo(taskKey.toUpperCase());
      const far = echo(targetTaskKey.toUpperCase());
      const held = endHolding(
        (await client.getTask(projectId, taskId)) as TaskEnds,
        targetTaskId,
        type
      );
      if (held === "far") {
        throw new Error(
          `${far} holds that ${type} link, not ${near}. Call unlink_tasks with the two keys the other way round. Nothing was removed.`
        );
      }
      if (held === "none") {
        throw new Error(
          `Neither ${near} nor ${far} holds a ${type} link to the other. get_task lists what each end holds. Nothing was removed.`
        );
      }

      await client.removeTaskLink(projectId, taskId, targetTaskId, type);
      return json(describeLink(type, taskKey, targetTaskKey, true));
    }
  );

  // --- Batches ---

  // Each item goes through the tool of the same name — the same validation, the same refusals, the same
  // history — one after another, and one that fails does not stop the rest. A batch is NOT atomic: the
  // answer says, item by item, what was done.
  const parsed = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
  // A batch where nothing worked is an error to the caller, with the per-item reasons still in the text
  const batchAnswer = (answer: Record<string, unknown>, nothingWorked: boolean) =>
    nothingWorked ? { ...json(answer), isError: true } : json(answer);

  server.registerTool(
    "create_tasks",
    {
      description:
        `Create up to ${BATCH_LIMIT} tasks on one board in one call, in order, each exactly as create_task would — ` +
        "and answer with one line per item: its key, or why it failed. One failing item does not stop the others, " +
        "and a batch is not atomic: nothing already made is undone. An item can name its `parent` and what it is " +
        "`blockedBy`, each either the key of a task that exists or `#3`, the third item of this same call (which has " +
        "to come earlier), so an epic and its sub-tasks are one call. A link that fails is reported on its item " +
        "(`linkErrors`) while the task it belongs to stays made.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          tasks: z
            .array(
              z
                .object({
                  ...CREATE_SHAPE,
                  parent: z.string().optional().describe("The task this one is a sub-task of: a key, or #n for an earlier item"),
                  blockedBy: z
                    .array(z.string())
                    .max(MAX_BLOCKERS_PER_ITEM)
                    .optional()
                    .describe(`Tasks that block this one: keys, or #n for earlier items (at most ${MAX_BLOCKERS_PER_ITEM})`),
                })
                .strict()
            )
            .min(1)
            .max(BATCH_LIMIT)
            // Every link is several requests behind the call, so the links are bounded as well as the items
            .refine(
              (items) => items.reduce((n, item) => n + (item.parent ? 1 : 0) + (item.blockedBy?.length ?? 0), 0) <= LINK_BATCH_LIMIT,
              `At most ${LINK_BATCH_LIMIT} links in one call, counting every parent and blocker`
            ),
        },
        { writes: true }
      ),
    },
    async ({ project, tasks }, extra) => {
      const made: (string | null)[] = [];
      const results: Record<string, unknown>[] = [];

      let stopped = false;
      for (const [at, item] of tasks.entries()) {
        const n = at + 1;
        // A client that gave up (its own timeout) must not leave the server making what it will ask for again
        if (extra.signal?.aborted) {
          stopped = true;
          made[at] = null;
          results.push({ n, error: "not attempted: the call was cancelled" });
          continue;
        }
        try {
          const { parent, blockedBy, ...fields } = item;
          // Every reference is read before anything is created, so a bad one refuses its item whole
          const parentKey = parent ? referencedKey(parent, made, n) : null;
          const blockerKeys = (blockedBy ?? []).map((ref) => referencedKey(ref, made, n));

          const created = parsed(await handlers.create_task({ project, ...fields, minimal: true }, extra));
          made[at] = created.key;

          const linkErrors: string[] = [];
          const link = async (taskKey: string, targetTaskKey: string, type: string, label: string) => {
            try {
              await handlers.link_tasks({ taskKey, targetTaskKey, type }, extra);
            } catch (error) {
              linkErrors.push(`${label}: ${failure(error)}`);
            }
          };
          if (parentKey) await link(parentKey, created.key, "parent_of", `parent ${parentKey}`);
          for (const blocker of blockerKeys) await link(created.key, blocker, "blocked_by", `blocked by ${blocker}`);

          results.push({ n, ...created, ...(linkErrors.length ? { linkErrors } : {}) });
        } catch (error) {
          made[at] = null;
          results.push({ n, error: failure(error) });
        }
      }

      const failed = results.filter((r) => r.error).length;
      return batchAnswer({ requested: tasks.length, created: tasks.length - failed, failed, ...(stopped ? { cancelled: true } : {}), results }, failed === tasks.length);
    }
  );

  server.registerTool(
    "update_tasks",
    {
      description:
        `Update up to ${BATCH_LIMIT} tasks in one call, in order, each exactly as update_task would, and answer with ` +
        "one line per item: the task as it now is, or why it failed. One failing item does not stop the others, and a " +
        "batch is not atomic: nothing already changed is undone.",
      inputSchema: strictInput(
        {
          updates: z
            .array(z.object({ taskKey: z.string().describe("Task key (e.g. 'CP-1')"), ...UPDATE_SHAPE }).strict())
            .min(1)
            .max(BATCH_LIMIT),
        },
        { writes: true }
      ),
    },
    async ({ updates }, extra) => {
      const results: Record<string, unknown>[] = [];
      for (const [at, item] of updates.entries()) {
        if (extra.signal?.aborted) {
          results.push({ n: at + 1, taskKey: item.taskKey.toUpperCase(), error: "not attempted: the call was cancelled" });
          continue;
        }
        try {
          results.push({ n: at + 1, ...parsed(await handlers.update_task({ ...item, minimal: true }, extra)) });
        } catch (error) {
          results.push({ n: at + 1, taskKey: item.taskKey.toUpperCase(), error: failure(error) });
        }
      }
      const failed = results.filter((r) => r.error).length;
      return batchAnswer({ requested: updates.length, updated: updates.length - failed, failed, results }, failed === updates.length);
    }
  );

  server.registerTool(
    "link_task_pairs",
    {
      description:
        `Link up to ${LINK_BATCH_LIMIT} pairs of tasks in one call, each exactly as link_tasks would (` +
        LINK_DIRECTION +
        ") and answer with one line per pair: what was linked, or why it was not. One failing pair does not stop the others.",
      inputSchema: strictInput(
        {
          links: z
            .array(
              z
                .object({
                  taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
                  targetTaskKey: z.string().describe("The task at the other end (e.g. 'CP-2')"),
                  type: z.enum(DEPENDENCY_TYPES).describe(LINK_TYPE_PARAM),
                })
                .strict()
            )
            .min(1)
            .max(LINK_BATCH_LIMIT),
        },
        { writes: true }
      ),
    },
    async ({ links }, extra) => {
      const results: Record<string, unknown>[] = [];
      for (const [at, pair] of links.entries()) {
        if (extra.signal?.aborted) {
          results.push({ n: at + 1, taskKey: pair.taskKey.toUpperCase(), targetTaskKey: pair.targetTaskKey.toUpperCase(), type: pair.type, error: "not attempted: the call was cancelled" });
          continue;
        }
        try {
          results.push({ n: at + 1, ...parsed(await handlers.link_tasks({ ...pair }, extra)) });
        } catch (error) {
          results.push({ n: at + 1, taskKey: pair.taskKey.toUpperCase(), targetTaskKey: pair.targetTaskKey.toUpperCase(), type: pair.type, error: failure(error) });
        }
      }
      const failed = results.filter((r) => r.error).length;
      return batchAnswer({ requested: links.length, linked: links.length - failed, failed, results }, failed === links.length);
    }
  );

  // --- Sprints ---

  server.registerTool(
    "list_sprints",
    {
      description: "List all sprints in a project",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.listSprints(proj._id));
    }
  );

  server.registerTool(
    "create_sprint",
    {
      description: "Create a new sprint in a project",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        name: z.string().describe("Sprint name"),
        startDate: z.string().describe("Start date (YYYY-MM-DD)"),
        endDate: z.string().describe("End date (YYYY-MM-DD)"),
        goal: z.string().optional().describe("Sprint goal"),
      }, { writes: true }),
    },
    async ({ project, name, startDate, endDate, goal }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.createSprint(proj._id, { name, startDate, endDate, goal }));
    }
  );

  server.registerTool(
    "get_sprint",
    {
      description:
        "One sprint with its dates, goal, status and counts, and its tasks as short lines, a page at a time " +
        "(default 50, at most 100; nextOffset is null on the last page).",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        sprint: z.string().describe("The sprint, by name or id"),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Page size (default ${DEFAULT_LIST_LIMIT})`),
        offset: z.number().int().min(0).optional().describe("Tasks to skip, from a previous answer's nextOffset"),
      }),
    },
    async ({ project, sprint, limit, offset }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const found = findSprint(sprint, (await client.listSprints(proj._id)) as SprintRow[]);
      const page = await client.pageTasks(proj._id, {
        sprint: found._id,
        limit: String(limit ?? DEFAULT_LIST_LIMIT),
        offset: String(offset ?? 0),
        view: "summary",
      });
      return json({
        sprint: sprintSummary(found),
        ...pageOf(
          (page.tasks as Parameters<typeof listedTask>[0][]).map((row) => listedTask(row, project.toUpperCase())),
          page.total,
          page.offset
        ),
      });
    }
  );

  server.registerTool(
    "delete_sprint",
    {
      description:
        "Delete a sprint. Its tasks are not deleted: every one goes back to the backlog, finished or not. To carry " +
        "the unfinished ones to another sprint instead, complete it with update_sprint and moveIncomplete first. " +
        "confirmName has to repeat the sprint's name, so a wrong name or id cannot delete the wrong sprint.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          sprint: z.string().describe("The sprint, by name or id"),
          confirmName: z.string().describe("The sprint's name, as list_sprints shows it (case does not matter), to confirm"),
        },
        { writes: true }
      ),
    },
    async ({ project, sprint, confirmName }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const found = findSprint(sprint, (await client.listSprints(proj._id)) as SprintRow[]);
      if (confirmName.trim().toLowerCase() !== found.name.trim().toLowerCase()) {
        throw new Error(
          `Not deleted: confirmName "${echo(confirmName)}" is not the name of that sprint, "${echo(found.name)}". Nothing was written.`
        );
      }
      await client.deleteSprint(proj._id, found._id);
      return json({ deleted: found.name, id: String(found._id), tasksReturnedToBacklog: found.taskCount ?? 0 });
    }
  );

  server.registerTool(
    "update_sprint",
    {
      description:
        "Update an existing sprint (name, dates, goal, status). Making a sprint active completes the board's other " +
        "active one. Completing a sprint can carry its unfinished tasks to the backlog or to another sprint with " +
        "moveIncomplete; without it they stay in the completed sprint.",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        sprintId: z.string().describe("The sprint, by name or id (list_sprints shows both)"),
        name: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        goal: z.string().optional(),
        status: z.string().optional().describe("planned, active, or completed"),
        moveIncomplete: z
          .string()
          .optional()
          .describe(
            "With status completed: where the tasks not in a done column go — \"backlog\", or another sprint " +
              "of this board that is not completed, by name or id"
          ),
      }, { writes: true }),
    },
    async ({ project, sprintId, name, startDate, endDate, goal, status, moveIncomplete }, extra) => {
      if (![name, startDate, endDate, goal, status, moveIncomplete].some((v) => v !== undefined)) {
        throw new Error(`update_sprint ${NOTHING_TO_CHANGE}`);
      }
      // Before any lookup, and before the route's move of unfinished tasks, which runs ahead of the write
      // that would then fail on it: a name that is blank or a day that is not one must not leave a sprint
      // open with its tasks already carried away
      if (name !== undefined && name.trim() === "") throw new Error("A sprint needs a name. Nothing was written.");
      for (const [label, day] of [["startDate", startDate], ["endDate", endDate]] as const) {
        if (day !== undefined && Number.isNaN(Date.parse(day))) {
          throw new Error(`Invalid ${label} "${echo(day)}" — a day, YYYY-MM-DD. Nothing was written.`);
        }
      }
      if (moveIncomplete !== undefined && status !== "completed") {
        throw new Error("moveIncomplete goes with status completed: it says where the unfinished tasks go as the sprint closes. Nothing was written.");
      }

      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (startDate !== undefined) updates.startDate = startDate;
      if (endDate !== undefined) updates.endDate = endDate;
      if (goal !== undefined) updates.goal = goal;
      if (status !== undefined) updates.status = status;

      // Named or numbered by the caller, but acted on by id — and checked against this board's own
      // sprints first, so a name two sprints share cannot complete the wrong one
      const sprints = (await client.listSprints(proj._id)) as SprintRow[];
      const target = findSprint(sprintId, sprints);
      if (moveIncomplete !== undefined) {
        Object.assign(updates, incompleteDestination(moveIncomplete, sprints, target));
      }

      return json(await client.updateSprint(proj._id, target._id, updates));
    }
  );

  // --- Comments ---

  server.registerTool(
    "add_comment",
    {
      description: "Add a comment to a task by task key (e.g. 'CP-1')",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        body: z.string().describe("Comment text"),
      }, { writes: true }),
    },
    async ({ taskKey, body }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.addComment(projectId, taskId, body));
    }
  );

  server.registerTool(
    "list_comments",
    {
      description:
        "A task's comments, oldest first, a page at a time (default 50, at most 100; nextOffset is null on the " +
        "last page). Each carries the id edit_comment and delete_comment address it by.",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Page size (default ${DEFAULT_LIST_LIMIT})`),
        offset: z.number().int().min(0).optional().describe("Comments to skip, from a previous answer's nextOffset"),
      }),
    },
    async ({ taskKey, limit, offset }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const all = (await client.listComments(projectId, taskId)) as Parameters<typeof commentLines>[0];
      const from = offset ?? 0;
      const page = all.slice(from, from + (limit ?? DEFAULT_LIST_LIMIT));
      const { tasks, ...rest } = pageOf(commentLines(page), all.length, from);
      return json({ ...rest, comments: tasks });
    }
  );

  server.registerTool(
    "edit_comment",
    {
      description:
        "Change the text of a comment — only the person who wrote it may, which for a connection is the account it " +
        "acts as (whoami). Take the id from list_comments.",
      inputSchema: strictInput(
        {
          taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
          commentId: z.string().describe("The comment's id, from list_comments"),
          body: z.string().describe("The new text"),
        },
        { writes: true }
      ),
    },
    async ({ taskKey, commentId, body }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const edited = (await client.editComment(projectId, taskId, commentId, body)) as Parameters<typeof commentLines>[0][number];
      return json(commentLines([edited])[0]);
    }
  );

  server.registerTool(
    "delete_comment",
    {
      description:
        "Delete a comment for good — only the person who wrote it may, which for a connection is the account it acts " +
        "as (whoami). Take the id from list_comments.",
      inputSchema: strictInput(
        {
          taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
          commentId: z.string().describe("The comment's id, from list_comments"),
        },
        { writes: true }
      ),
    },
    async ({ taskKey, commentId }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      await client.deleteComment(projectId, taskId, commentId);
      return json({ deleted: commentId, taskKey: taskKey.toUpperCase() });
    }
  );

  server.registerTool(
    "get_task_activity",
    {
      description:
        "What changed on a task, newest first: when, by whom, which field and the value before and after. A run of " +
        "edits to one field by one person reads as one entry, as on the task page. At most 100 entries exist to read.",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe("Entries to return (default 30)"),
      }),
    },
    async ({ taskKey, limit }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const logs = (await client.getTaskActivity(projectId, taskId)) as Parameters<typeof activityLines>[0];
      return json({ total: logs.length, entries: activityLines(logs, limit ?? 30) });
    }
  );

  // --- Board setup: configuration that can only be added to ---

  server.registerTool(
    "add_custom_field",
    {
      description:
        "Add a project field to a board: text, number, date, checkbox, or a dropdown or multiselect with its options. " +
        "update_task and create_task then take it by name in `fields`. As in the app, any member of the board may " +
        `add one, and its name must be new on the board. ${ADD_ONLY} A field cannot be renamed, archived or deleted ` +
        "here, nor an option removed — add_field_option adds one. Answers with the field and each option's id.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          name: z.string().describe("The field's name, new on this board"),
          fieldType: z.enum(CUSTOM_FIELD_TYPES as [string, ...string[]]).describe(CUSTOM_FIELD_TYPES.join(", ")),
          options: z
            .array(z.union([z.string(), z.object({ value: z.string(), color: COLOUR_PARAM }).strict()]))
            .max(MAX_OPTIONS)
            .optional()
            .describe(
              "For dropdown and multiselect, and only for those: the choices, each a string or { value, color } (#rrggbb)"
            ),
          required: z.boolean().optional().describe("Every task must fill it (default: not)"),
          showOnCard: z.boolean().optional().describe("Show its value on the board's cards (default: not)"),
          showInList: z.boolean().optional().describe("Offer it as a column in the list view (default: not)"),
          filterable: z.boolean().optional().describe("Offer it as a board filter (default: not)"),
        },
        {
          writes: true,
          hints: {
            archived: "the app: a field is archived or deleted there",
            order: "the app: fields are reordered there",
          },
        }
      ),
    },
    async ({ project, name, fieldType, options, required, showOnCard, showInList, filterable }, extra) => {
      const hasOptions = OPTION_FIELD_TYPES.includes(fieldType as never);
      if (hasOptions && !options?.length) {
        throw new Error(`A ${fieldType} field needs at least one option. Nothing was written.`);
      }
      if (!hasOptions && options !== undefined) {
        throw new Error(`A ${fieldType} field has no options — leave options out. Nothing was written.`);
      }
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const fields = await client.addCustomField(proj._id, {
        name,
        fieldType,
        ...(options ? { options } : {}),
        ...(required !== undefined ? { required } : {}),
        ...(showOnCard !== undefined ? { showOnCard } : {}),
        ...(showInList !== undefined ? { showInList } : {}),
        ...(filterable !== undefined ? { filterable } : {}),
      });
      return json({ field: fieldSummary(fields[fields.length - 1]), fieldCount: fields.length });
    }
  );

  server.registerTool(
    "add_field_option",
    {
      description:
        "Add one option to the end of a board's dropdown or multiselect field, in one update: the options it has, and " +
        "every task's choice among them, are left alone. As in the app, any member of the board may. An option cannot " +
        "be renamed, recoloured, reordered or removed here. Answers with the new option and the field's options, by id.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          field: z.string().describe("The field, by name or id — get_project lists them"),
          option: z.string().describe("The new option's text, which the field does not already offer (any case)"),
          color: COLOUR_PARAM.describe("The option's colour, #rrggbb (default: grey)"),
        },
        { writes: true }
      ),
    },
    async ({ project, field, option, color }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const found = findField(field, proj.customFields ?? []);
      if (!OPTION_FIELD_TYPES.includes(found.fieldType)) {
        throw new Error(`${found.name} is a ${found.fieldType} field and has no options. Nothing was written.`);
      }
      const added = await client.addFieldOption(proj._id, String(found._id), { value: option, ...(color ? { color } : {}) });
      return json({
        field: added.field.name,
        added: { id: added.option.id, value: added.option.value, color: added.option.color },
        options: optionLines(added.field.options),
      });
    }
  );

  server.registerTool(
    "add_category",
    {
      description:
        "Add a category to a board, which tasks can then be filed under. As in the app, any member of the board may; " +
        `the name must be new on the board (any case), and a board holds a limited number. ${ADD_ONLY} A category ` +
        "cannot be renamed, recoloured or deleted here. Answers with the board's categories.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          name: z.string().describe("The category's name"),
          color: COLOUR_PARAM.describe("A colour, #rrggbb (default: blue)"),
        },
        { writes: true }
      ),
    },
    async ({ project, name, color }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const categories = await client.addCategory(proj._id, { name, ...(color ? { color } : {}) });
      const added = categories[categories.length - 1];
      return json({ added: { name: added.name, color: added.color }, categories: categories.map((c) => c.name) });
    }
  );

  const roleGuide = COLUMN_ROLES.map((role) => `${role} (${ROLE_LABELS[role].label}: ${ROLE_LABELS[role].hint})`).join(" ");

  server.registerTool(
    "add_column",
    {
      description:
        "Add one column to the end of a board, in one update that leaves the others alone. Needs the project owner, as " +
        "the Board settings do. The role is what automation follows — never the name: " +
        `${roleGuide} The id comes from the label and is what change_task_status takes. The column does not ask the ` +
        `PM agent for a review (the app sets that). ${ADD_ONLY} A column cannot be removed, reordered or given another ` +
        "role here. Answers with the new column and the board's columns.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          label: z.string().describe("The column's name, at most 40 characters"),
          role: z.enum(COLUMN_ROLES).describe("What the column means to automation"),
          color: COLOUR_PARAM.describe("A colour, #rrggbb (default: grey)"),
        },
        {
          writes: true,
          hints: {
            order: "the app: columns are reordered there",
            triggersPmReview: "the app: Settings → Board",
          },
        }
      ),
    },
    async ({ project, label, role, color }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      requireOwner(proj, project, "add a column");
      const before = new Set(effectiveColumns(proj.columns).map((c) => c.id));
      const columns = await client.addColumn(proj._id, { label, role, ...(color ? { color } : {}) });
      const fresh = columns.filter((c) => !before.has(c.id));
      const added = fresh.find((c) => c.label === label.trim() && c.role === role) ?? fresh[0];
      return json({ added: added ? columnSummary(added) : null, columns: columns.map(columnSummary) });
    }
  );

  server.registerTool(
    "rename_column",
    {
      description:
        "Change one column's label, in one update that leaves the rest of the board alone. Needs the project owner. " +
        "The column's id, role and tasks do not change, so nothing that points at it breaks. Its role, colour and " +
        "position cannot be changed here, and a column cannot be removed. Answers with the board's columns.",
      inputSchema: strictInput(
        {
          project: z.string().describe("Project key (e.g. 'CP')"),
          column: z.string().describe("The column, by id or label — get_project lists them"),
          label: z.string().describe("The new label, at most 40 characters"),
        },
        {
          writes: true,
          hints: { role: "the app: Settings → Board", color: "the app: Settings → Board", order: "the app: Settings → Board" },
        }
      ),
    },
    async ({ project, column, label }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      requireOwner(proj, project, "rename a column");
      const found = findColumn(column, proj.columns);
      const columns = await client.renameColumn(proj._id, found.id, label);
      return json({ renamed: columnSummary(columns.find((c) => c.id === found.id) ?? found), columns: columns.map(columnSummary) });
    }
  );

  // --- Repository ---

  server.registerTool(
    "sync_repository",
    {
      description:
        "Refresh a board's pull requests (GitHub) or merge requests (GitLab) from its repository now, which is what the " +
        "Sync button in the app does: it re-links them to their tasks by the task key in the branch or title, and " +
        "refreshes the CI result each shows. Like the button, a task whose request has merged moves to the next " +
        "review column. The provider is the one the board's repository is on. A board with no repository or no stored " +
        "token is refused, saying which. Answers with a few counts and a sentence; no token or provider answer is passed on.",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }, { writes: true }),
    },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const full = await client.getProject(proj._id);
      const provider = syncProvider(full, project);
      return json(syncSummary(provider, (await client.syncRepository(proj._id, provider)) as Parameters<typeof syncSummary>[1]));
    }
  );
}
