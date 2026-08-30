import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { PlannerClient } from "./planner-client";
import { resolveFieldsByName } from "@/lib/custom-fields";
import { APP_NAME } from "@/lib/brand";
import {
  strictInput,
  NOTHING_TO_CHANGE,
  CREATE_TASK_HINTS,
  UPDATE_TASK_HINTS,
  CHANGE_STATUS_HINTS,
} from "./strict-input";

type ToolExtra = { authInfo?: AuthInfo };

function clientFrom(extra: ToolExtra): PlannerClient {
  const auth = extra.authInfo;
  if (!auth) throw new Error("Unauthorized");
  const baseUrl = auth.extra?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error("Missing base URL in auth context");
  }
  return new PlannerClient(baseUrl, auth.token);
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerPlannerTools(server: McpServer): void {
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

  // --- Tasks ---

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks in a project with optional filters",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        status: z
          .string()
          .optional()
          .describe(
            "Filter by status (comma-separated): planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done"
          ),
        assignee: z.string().optional().describe("Filter by assignee username"),
        category: z.string().optional().describe("Filter by category: bug, doc, user-story, idea"),
        priority: z.string().optional().describe("Filter by priority: low, medium, high, urgent"),
      }),
    },
    async ({ project, status, assignee, category, priority }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (assignee) filters.assignee = assignee;
      if (category) filters.category = category;
      if (priority) filters.priority = priority;
      return json(await client.listTasks(proj._id, filters));
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Get full task details by task key (e.g. 'CP-1')",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }),
    },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.getTask(projectId, taskId));
    }
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a new task in a project",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        priority: z.string().optional().describe("Priority: low, medium, high, or urgent (default: medium)"),
        category: z.string().optional().describe("Category: bug, doc, user-story, idea"),
        assignee: z
          .string()
          .optional()
          .describe(
            "Assignee username. A new task never names an agent — hand it to a machine with " +
              "update_task once it exists."
          ),
        status: z.string().optional().describe("Initial status (default: planned)"),
        acceptanceCriteria: z
          .string()
          .optional()
          .describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name, e.g. { \"Owoce\": \"Apples\" }. " +
              "get_project lists this project's fields and the options each one accepts."
          ),
      }, { hints: CREATE_TASK_HINTS, writes: true }),
    },
    async ({ project, title, description, priority, category, assignee, status, acceptanceCriteria, fields }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const data: Record<string, unknown> = { title };

      if (description) data.description = description;
      if (priority) data.priority = priority;
      if (category) data.category = category;
      if (status) data.status = status;
      if (acceptanceCriteria) data.acceptanceCriteria = acceptanceCriteria;
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
            `"${assignee}" is not someone this board can be assigned to — only people with access to it are.`
          );
        }
        data.assignee = user.username;
      }

      return json(await client.createTask(proj._id, data));
    }
  );

  server.registerTool(
    "update_task",
    {
      description: "Update an existing task's fields by task key",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
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
              "what a task somebody is doing by hand looks like. Instance admins only."
          ),
        acceptanceCriteria: z
          .string()
          .optional()
          .describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name. Only the named fields change; " +
              "the task's other field values are left alone. get_project lists them."
          ),
      }, { hints: UPDATE_TASK_HINTS, writes: true }),
    },
    async ({ taskKey, title, description, priority, category, assignee, agent, acceptanceCriteria, fields }, extra) => {
      // Before the lookup, so a call that changes nothing costs nothing and the refusal is the
      // first thing that happens rather than the last
      if (![title, description, priority, category, assignee, agent, acceptanceCriteria, fields].some((v) => v !== undefined)) {
        throw new Error(`update_task ${NOTHING_TO_CHANGE}`);
      }

      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const data: Record<string, unknown> = {};

      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (category !== undefined) data.category = category;
      if (acceptanceCriteria !== undefined) data.acceptanceCriteria = acceptanceCriteria;

      if (fields && Object.keys(fields).length) {
        // customFieldValues is replaced wholesale by the API, so naming one field
        // would otherwise clear every other value on the task
        const project = await client.getProject(projectId);
        const task = (await client.getTask(projectId, taskId)) as {
          customFieldValues?: Record<string, unknown>;
        };
        data.customFieldValues = {
          ...(task.customFieldValues || {}),
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
              `"${assignee}" is not someone this board can be assigned to — only people with access to it are.`
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
          const agents = (await client.listAgents()) as { _id: string; name: string }[];
          const match = agents.find((a) => a.name.toLowerCase() === agent.toLowerCase());
          if (!match) throw new Error(`Agent "${agent}" not found`);
          data.agent = match._id;
        } else {
          data.agent = null;
        }
      }

      // An empty update still bumps updatedAt, which is the one field that reads as proof
      // something was written (BP-497)
      if (Object.keys(data).length === 0) throw new Error(`update_task ${NOTHING_TO_CHANGE}`);

      return json(await client.updateTask(projectId, taskId, data));
    }
  );

  server.registerTool(
    "change_task_status",
    {
      description: "Change the status of a task. Valid: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        status: z.string().describe("New status"),
      }, { hints: CHANGE_STATUS_HINTS, writes: true }),
    },
    async ({ taskKey, status }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.changeTaskStatus(projectId, taskId, status));
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
    "update_sprint",
    {
      description: "Update an existing sprint (name, dates, goal, status)",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        sprintId: z.string().describe("Sprint ID"),
        name: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        goal: z.string().optional(),
        status: z.string().optional().describe("planned, active, or completed"),
      }, { writes: true }),
    },
    async ({ project, sprintId, name, startDate, endDate, goal, status }, extra) => {
      if (![name, startDate, endDate, goal, status].some((v) => v !== undefined)) {
        throw new Error(`update_sprint ${NOTHING_TO_CHANGE}`);
      }

      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (startDate !== undefined) updates.startDate = startDate;
      if (endDate !== undefined) updates.endDate = endDate;
      if (goal !== undefined) updates.goal = goal;
      if (status !== undefined) updates.status = status;
      if (Object.keys(updates).length === 0) throw new Error(`update_sprint ${NOTHING_TO_CHANGE}`);

      return json(await client.updateSprint(proj._id, sprintId, updates));
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
      description: "List all comments on a task by task key (e.g. 'CP-1')",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }),
    },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.listComments(projectId, taskId));
    }
  );
}
