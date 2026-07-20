import { Types } from "mongoose";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { TASK_STATUSES } from "@/types";
import {
  createTask,
  updateTask,
  changeStatus,
  assignTask,
  addComment,
} from "@/lib/task-service";
import { OrToolDefinition } from "./openrouter";

export interface PmToolContext {
  projectId: string;
  projectKey: string;
  pmUserId: string;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compactTask(ctx: PmToolContext, t: any) {
  return {
    key: `${ctx.projectKey}-${t.taskNumber}`,
    title: t.title,
    status: t.status,
    assignee: t.assignee && typeof t.assignee === "object" ? t.assignee.username : null,
    difficulty: t.difficulty,
  };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export const PM_TOOLS: Record<string, PmTool> = {
  list_tasks: {
    write: false,
    definition: {
      name: "list_tasks",
      description:
        "List tasks in the project (compact: key, title, status, assignee, difficulty). Use get_task for full details.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...TASK_STATUSES], description: "Optional status filter" },
          limit: { type: "number", description: "Max results, default 50, cap 100" },
          offset: { type: "number", description: "Skip N results (pagination)" },
        },
      },
    },
    async execute(args, ctx) {
      const filter: Record<string, unknown> = { project: ctx.projectId };
      if (args.status !== undefined) {
        if (!TASK_STATUSES.includes(args.status as never)) {
          return { result: { error: `Invalid status. One of: ${TASK_STATUSES.join(", ")}` } };
        }
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
          component: t.component,
          dueDate: t.dueDate,
          labels: t.labels,
          checklist: (t.checklist || []).map((c) => ({ text: c.text, done: c.done })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          blockedBy: (t.blockedBy || []).map((b: any) =>
            typeof b === "object" && b.taskNumber
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
      parameters: { type: "object", properties: {} },
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
        "Create a new task. Tasks are ALWAYS created in status 'planned' (backlog); a human moves them to todo.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          difficulty: { type: "string", enum: ["S", "M", "L", "XL"] },
          category: { type: "string", enum: ["bug", "doc", "user-story", "idea"] },
          component: { type: "string" },
          acceptanceCriteria: { type: "string", description: "Markdown checklist, e.g. '- [ ] item'" },
          assignee: { type: "string", description: "Username, optional" },
        },
        required: ["title"],
      },
    },
    async execute(args, ctx) {
      const title = str(args.title).trim();
      if (!title) return { result: { error: "title is required" } };
      const result = await createTask(ctx.projectId, ctx.pmUserId, {
        title,
        description: str(args.description),
        difficulty: args.difficulty,
        category: args.category,
        component: str(args.component),
        acceptanceCriteria: str(args.acceptanceCriteria),
        assignee: args.assignee,
        status: "planned", // forced: PM never creates outside the backlog
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
        "Update a task's content fields (title, description, difficulty, category, component, acceptanceCriteria, dueDate). Use change_status / assign_task for status and assignee.",
      parameters: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          difficulty: { type: "string", enum: ["S", "M", "L", "XL"] },
          category: { type: "string", enum: ["bug", "doc", "user-story", "idea"] },
          component: { type: "string" },
          acceptanceCriteria: { type: "string" },
          dueDate: { type: "string", description: "YYYY-MM-DD or empty to clear" },
        },
        required: ["taskKey"],
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const allowed = ["title", "description", "difficulty", "category", "component", "acceptanceCriteria", "dueDate"];
      const body: Record<string, unknown> = {};
      for (const field of allowed) {
        if (args[field] !== undefined) body[field] = args[field];
      }
      if (Object.keys(body).length === 0) {
        return { result: { error: "Provide at least one field to update" } };
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
          status: { type: "string", enum: [...TASK_STATUSES] },
        },
        required: ["taskKey", "status"],
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
      },
    },
    async execute(args, ctx) {
      const resolved = await resolveTask(ctx, args.taskKey);
      if ("error" in resolved) return { result: { error: resolved.error } };
      const username = args.username === null ? null : str(args.username).trim() || null;
      const result = await assignTask(ctx.projectId, String(resolved.task._id), username, ctx.pmUserId);
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
      return {
        result: { task: key, assignee },
        action: { tool: "assign_task", taskKey: key, summary: assignee ? `${key} → @${assignee}` : `${key} unassigned` },
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
