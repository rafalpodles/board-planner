import { Types } from "mongoose";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { Comment } from "@/models/comment";
import { PRIORITIES } from "@/types";
import { resolveFieldsByName } from "@/lib/custom-fields";
import {
  createTask,
  updateTask,
  changeStatus,
  assignTask,
  addComment,
} from "@/lib/task-service";
import { OrToolDefinition } from "./openrouter";
import { unknownParameterMessage, NOTHING_TO_CHANGE } from "@/lib/mcp/strict-input";
import { buildBoardDigest } from "./board-review";
import { handoverOf } from "@/lib/handover";
import { getProjectColumns } from "@/lib/columns";

export interface PmToolContext {
  projectId: string;
  projectKey: string;
  pmUserId: string;
  /** The user whose turn this is. Equal to pmUserId when nobody is driving it. */
  triggeredByUserId: string;
}

/**
 * The person on whose instruction the PM is assigning, or null when nobody is.
 *
 * BP-419 made a PM assignment claimable, and the claim's own filter pairs this with
 * `assignee: <machine owner>` — so a machine runs a PM hand-over only when the person who asked
 * for it is the person receiving it. Without this, the PM chat is reachable by any project member
 * (`check(user, projectId, "access")`), and asking it to assign a task to a colleague would start
 * a run on that colleague's machine, carrying text the member wrote. The old filter refused every
 * PM assignment, so that path did not exist before this change and must not be opened by it.
 */
function onWhoseInstruction(ctx: PmToolContext): string | null {
  return ctx.triggeredByUserId && ctx.triggeredByUserId !== ctx.pmUserId
    ? ctx.triggeredByUserId
    : null;
}

/** createTask, carrying whose instruction the PM is acting on — see onWhoseInstruction */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTaskOnInstruction(ctx: PmToolContext, body: any) {
  return createTask(ctx.projectId, ctx.pmUserId, body, onWhoseInstruction(ctx));
}

export interface PmToolOutcome {
  result: unknown;
  action?: { tool: string; taskKey?: string; summary: string };
}

interface PmTool {
  definition: OrToolDefinition;
  write: boolean;
  execute(args: Record<string, unknown>, ctx: PmToolContext): Promise<PmToolOutcome>;
}

const MAX_TEXT_RESULT = 4000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveTask(ctx: PmToolContext, taskKey: unknown): Promise<{ task: any } | { error: string }> {
  if (typeof taskKey !== "string" || !taskKey.trim()) {
    return { error: "taskKey is required, e.g. " + ctx.projectKey + "-12" };
  }
  const match = taskKey.trim().toUpperCase().match(/-?(\d+)$/);
  if (!match) {
    return { error: `Invalid taskKey format: ${taskKey}` };
  }
  const task = await Task.findOne({ project: ctx.projectId, taskNumber: Number(match[1]) });
  if (!task) {
    return { error: `Task ${taskKey} not found in this project` };
  }
  return { task };
}

/**
 * Project fields arrive from the model keyed by name; the API only stores ids.
 * Difficulty and Component are ordinary fields since CP-213, so this is the only
 * way the PM can set them.
 */
async function fieldValuesFor(
  projectId: string,
  fields: unknown
): Promise<Record<string, unknown> | { error: string }> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const entries = fields as Record<string, unknown>;
  if (!Object.keys(entries).length) return {};
  const project = await Project.findById(projectId, "customFields").lean();
  try {
    return resolveFieldsByName(entries, (project?.customFields || []) as never);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown field" };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compactTask(ctx: PmToolContext, t: any) {
  return {
    key: `${ctx.projectKey}-${t.taskNumber}`,
    title: t.title,
    status: t.status,
    assignee: t.assignee && typeof t.assignee === "object" ? t.assignee.username : null,
    priority: t.priority,
  };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * BP-500. The tools whitelist the fields they apply and used to drop the rest without a word, which
 * is the shape BP-497 fixed on the two MCP servers: a model that names `status` here is told the
 * update succeeded and reads its own intention back. The schema the model is given now says
 * `additionalProperties: false`, and this is the half that enforces it.
 */
const PM_TOOL_HINTS: Record<string, string> = {
  status: "the change_status tool",
  assignee: "the assign_task tool",
  checklist: "acceptanceCriteria, a markdown checklist",
  difficulty: "the fields parameter, keyed by field name",
  component: "the fields parameter, keyed by field name",
  customFieldValues: "the fields parameter, keyed by field name",
};

export function refuseUndeclaredArgs(tool: PmTool, args: Record<string, unknown>): string | null {
  const declared =
    (tool.definition.parameters as { properties?: Record<string, unknown> }).properties || {};
  const stray = Object.keys(args).filter((key) => !Object.hasOwn(declared, key));

  return stray.length ? unknownParameterMessage(stray, PM_TOOL_HINTS, tool.write) : null;
}


/**
 * Why nothing will run this task, or "" when nothing about it is in the way.
 *
 * BP-419 made the PM's assignment a real hand-over, but not every hand-over completes: a task
 * naming no agent is one a person is doing, and a project not enabled for workers runs nothing at
 * all. Those have to be said where the PM says it assigned the work — the Agent row on the task
 * detail is a view nobody reopens after reading "BP-x → @rafal" in the chat.
 *
 * Deliberately not a promise of the opposite. The claim also weighs open blockers, spent attempts
 * and whether that person owns a live machine at all, none of which is knowable here, so "" means
 * "no reason found", never "it will run".
 */
async function whyItWillNotRun(
  projectId: string,
  task: { agent?: unknown; assignee?: unknown; assignedBy?: unknown; status?: unknown }
): Promise<string> {
  const project = await Project.findById(projectId, "columns worker").lean();
  if (!project || project.worker?.enabled !== true) {
    return "this project is not enabled for workers, so nothing will run it";
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handover = handoverOf(task as any, getProjectColumns(project));
  if (handover.runs) return "";
  // A switch with no fall-through on purpose: the first version of this returned "" for the three
  // reasons it did not name, and two of them are reachable *immediately after a successful
  // assignment* — `updateTask` stamps `assignedBy` only when the assignee actually moves, so
  // re-assigning a legacy task to the person who already holds it leaves the assigner unrecorded,
  // and re-assigning a task somebody else handed over leaves theirs. Both then answered
  // "BP-x → @rpo" with no caveat and were never claimed: the exact silence this ticket exists to
  // end, reproduced inside the feature written to end it.
  switch (handover.reason) {
    case "no-agent":
      return "no agent is named on it, so nothing will run it — a task naming none is one a person is doing";
    case "not-approved-yet":
      return "it is not in a column a machine claims from, so nothing will run it yet";
    case "unassigned":
      return "it ended up assigned to nobody, so nothing will run it";
    case "assigner-unrecorded":
      return "the board has no record of who handed it over — it was already assigned to them, so this changed nothing — and nothing will run it until its assignee assigns it to themselves";
    case "assigned-by-someone-else":
      return "somebody else is still recorded as having assigned it — it was already assigned to them, so this changed nothing — and a machine takes only work its owner or the PM handed over";
    case "pm-assigned-for-someone-else":
      return "it was handed over on somebody else's instruction, so nothing will run it";
  }
}

export const PM_TOOLS: Record<string, PmTool> = {
  list_tasks: {
    write: false,
    definition: {
      name: "list_tasks",
      description:
        "List tasks in the project (compact: key, title, status, assignee, priority). Use get_task for full details.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional status filter — a column id of this project (see the system prompt)" },
          limit: { type: "number", description: "Max results, default 50, cap 100" },
          offset: { type: "number", description: "Skip N results (pagination)" },
        },
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const filter: Record<string, unknown> = { project: ctx.projectId };
      if (args.status !== undefined) {
        filter.status = args.status;
      }
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const [total, tasks] = await Promise.all([
        Task.countDocuments(filter),
        Task.find(filter)
          .sort({ taskNumber: -1 })
          .skip(offset)
          .limit(limit)
          .populate("assignee", "username"),
      ]);
      return { result: { total, offset, tasks: tasks.map((t) => compactTask(ctx, t)) } };
    },
  },

  get_task: {
    write: false,
    definition: {
      name: "get_task",
      description: "Get full details of one task by key (e.g. CP-12).",
      parameters: {
        type: "object",
        properties: { taskKey: { type: "string" } },
        required: ["taskKey"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const t = await Task.findById(resolved.task._id)
        .populate("assignee", "username fullName")
        .populate("blockedBy", "taskNumber title status");
      if (!t) return { result: { error: "Task not found" } };
      return {
        result: {
          ...compactTask(ctx, t),
          description: (t.description || "").slice(0, MAX_TEXT_RESULT),
          category: t.category,
          dueDate: t.dueDate,
          checklist: (t.checklist || []).map((c) => ({ text: c.text, done: c.done })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          blockedBy: (t.blockedBy || []).map((b: any) =>
            b && typeof b === "object" && b.taskNumber
              ? { key: `${ctx.projectKey}-${b.taskNumber}`, title: b.title, status: b.status }
              : null
          ).filter(Boolean),
          recurrence: t.recurrence,
        },
      };
    },
  },

  get_project_stats: {
    write: false,
    definition: {
      name: "get_project_stats",
      description: "Task counts by status for the project.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_args, ctx) {
      const rows = await Task.aggregate([
        { $match: { project: resolveObjectId(ctx.projectId) } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const byStatus: Record<string, number> = {};
      for (const row of rows) byStatus[row._id] = row.count;
      const total = rows.reduce((sum, r) => sum + r.count, 0);
      return { result: { total, byStatus } };
    },
  },

  get_board_digest: {
    write: false,
    definition: {
      name: "get_board_digest",
      description:
        "Scan the open board for tasks missing acceptance criteria or a description, tasks sitting in the same column for a long time, and likely duplicates by title. Heuristic — confirm with get_task before acting.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_args, ctx) {
      const digest = await buildBoardDigest(ctx.projectId);
      return { result: digest ?? { error: "Project not found" } };
    },
  },

  list_comments: {
    write: false,
    definition: {
      name: "list_comments",
      description: "List comments on a task (newest last).",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          limit: { type: "number", description: "Max results, default 20" },
        },
        required: ["taskKey"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const comments = await Comment.find({ task: resolved.task._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("author", "username");
      return {
        result: comments.reverse().map((c) => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          author: c.author && typeof c.author === "object" ? (c.author as any).username : null,
          body: (c.body || "").slice(0, 1000),
          createdAt: c.createdAt,
        })),
      };
    },
  },

  create_task: {
    write: true,
    definition: {
      name: "create_task",
      description:
        "Create a new task. Tasks are ALWAYS created in the project's backlog-role column; a human approves them onward.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: [...PRIORITIES], description: "Default: medium" },
          category: { type: "string", description: "One of the project's configured categories (see the project context; defaults: bug, doc, user-story, idea)" },
          fields: { type: "object", description: "Project fields keyed by name, e.g. { \"Difficulty\": \"M\", \"Component\": \"ui\" } — see the project context for the field list" },
          acceptanceCriteria: { type: "string", description: "Markdown checklist, e.g. '- [ ] item'" },
          assignee: { type: "string", description: "Username, optional" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const title = str(args.title).trim();
      if (!title) return { result: { error: "title is required" } };
      const resolvedFields = await fieldValuesFor(ctx.projectId, args.fields);
      if ("error" in resolvedFields) return { result: { error: resolvedFields.error as string } };
      const createFields = Object.keys(resolvedFields).length
        ? { customFieldValues: resolvedFields }
        : {};
      const result = await createTaskOnInstruction(ctx, {
        title,
        description: str(args.description),
        priority: args.priority,
        category: args.category,
        acceptanceCriteria: str(args.acceptanceCriteria),
        ...(createFields as Record<string, unknown>),
        assignee: args.assignee,
        // status omitted on purpose: task-service defaults to the backlog-role
        // column, and the PM must never create outside the backlog
      });
      if (!result.ok) return { result: { error: result.error } };
      const key = `${ctx.projectKey}-${result.data.taskNumber}`;
      return {
        result: { created: key, title: result.data.title, status: result.data.status },
        action: { tool: "create_task", taskKey: key, summary: `Created ${key}: ${title}` },
      };
    },
  },

  update_task: {
    write: true,
    definition: {
      name: "update_task",
      description:
        "Update a task's content fields (title, description, priority, category, acceptanceCriteria, dueDate) and its project fields via `fields`. Use change_status / assign_task for status and assignee.",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: [...PRIORITIES] },
          category: { type: "string", description: "One of the project's configured categories (see the project context; defaults: bug, doc, user-story, idea)" },
          fields: { type: "object", description: "Project fields keyed by name, e.g. { \"Difficulty\": \"L\" }. Only the named fields change." },
          acceptanceCriteria: { type: "string" },
          dueDate: { type: "string", description: "YYYY-MM-DD or empty to clear" },
        },
        required: ["taskKey"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const allowed = ["title", "description", "priority", "category", "acceptanceCriteria", "dueDate"];
      const body: Record<string, unknown> = {};
      for (const field of allowed) {
        if (args[field] !== undefined) body[field] = args[field];
      }
      const updates = await fieldValuesFor(ctx.projectId, args.fields);
      if ("error" in updates) return { result: { error: updates.error as string } };
      if (Object.keys(updates).length) {
        // customFieldValues is replaced wholesale, so the task's other values are
        // merged back in rather than cleared by naming a single field
        const current = (resolved.task.customFieldValues || {}) as Record<string, unknown>;
        const merged = current instanceof Map ? Object.fromEntries(current) : { ...current };
        body.customFieldValues = { ...merged, ...updates };
      }
      if (Object.keys(body).length === 0) {
        return { result: { error: `update_task ${NOTHING_TO_CHANGE}` } };
      }
      const result = await updateTask(ctx.projectId, String(resolved.task._id), body, ctx.pmUserId);
      if (!result.ok) return { result: { error: result.error } };
      const key = `${ctx.projectKey}-${result.data.taskNumber}`;
      return {
        result: { updated: key, fields: Object.keys(body) },
        action: { tool: "update_task", taskKey: key, summary: `Updated ${key} (${Object.keys(body).join(", ")})` },
      };
    },
  },

  change_status: {
    write: true,
    definition: {
      name: "change_status",
      description: "Move a task to another status.",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          status: { type: "string", description: "A column id of this project's board (see the system prompt)" },
        },
        required: ["taskKey", "status"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const result = await changeStatus(
        ctx.projectId,
        String(resolved.task._id),
        str(args.status),
        ctx.pmUserId
      );
      if (!result.ok) return { result: { error: result.error } };
      const key = `${ctx.projectKey}-${result.data.taskNumber}`;
      return {
        result: { task: key, status: result.data.status },
        action: { tool: "change_status", taskKey: key, summary: `${key} → ${result.data.status}` },
      };
    },
  },

  assign_task: {
    write: true,
    definition: {
      name: "assign_task",
      description: "Assign a task to a user by username, or unassign with null.",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          username: { type: ["string", "null"], description: "Username or null to unassign" },
        },
        required: ["taskKey", "username"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const username = args.username === null ? null : str(args.username).trim() || null;
      const result = await assignTask(
        ctx.projectId,
        String(resolved.task._id),
        username,
        ctx.pmUserId,
        onWhoseInstruction(ctx)
      );
      if (!result.ok) return { result: { error: result.error } };
      const key = `${ctx.projectKey}-${result.data.taskNumber}`;
      const assignee =
        result.data.assignee && typeof result.data.assignee === "object"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (result.data.assignee as any).username
          : null;
      if (username && !assignee) {
        return { result: { error: `User '${username}' not found — task ${key} is now unassigned` } };
      }
      if (!assignee) {
        return {
          result: { task: key, assignee: null },
          action: { tool: "assign_task", taskKey: key, summary: `${key} unassigned` },
        };
      }

      // Said in the same breath as the assignment, rather than left to a view nobody reopens
      const blocked = await whyItWillNotRun(ctx.projectId, result.data);
      return {
        result: blocked
          ? { task: key, assignee, willRun: false, note: `Assigned, but ${blocked}.` }
          : { task: key, assignee },
        action: {
          tool: "assign_task",
          taskKey: key,
          summary: blocked ? `${key} → @${assignee} (${blocked})` : `${key} → @${assignee}`,
        },
      };
    },
  },

  add_comment: {
    write: true,
    definition: {
      name: "add_comment",
      description: "Add a comment to a task.",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          body: { type: "string" },
        },
        required: ["taskKey", "body"],
        additionalProperties: false,
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const result = await addComment(ctx.projectId, String(resolved.task._id), str(args.body), {
        id: ctx.pmUserId,
        username: "pm",
      });
      if (!result.ok) return { result: { error: result.error } };
      const key = `${ctx.projectKey}-${resolved.task.taskNumber}`;
      return {
        result: { commented: key },
        action: { tool: "add_comment", taskKey: key, summary: `Commented on ${key}` },
      };
    },
  },
};

export function pmToolDefinitions(): OrToolDefinition[] {
  return Object.values(PM_TOOLS).map((t) => t.definition);
}

function resolveObjectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}
