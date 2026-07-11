import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { PlannerClient } from "./planner-client";

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

  server.tool("list_projects", "List all projects in ClaudePlanner", {}, async (_args, extra) => {
    return json(await clientFrom(extra).listProjects());
  });

  server.tool(
    "get_project",
    "Get project details by project key (e.g. 'CP') or project ID",
    { identifier: z.string().describe("Project key (e.g. 'CP') or project ID") },
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

  server.tool(
    "list_tasks",
    "List tasks in a project with optional filters",
    {
      project: z.string().describe("Project key (e.g. 'CP')"),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status (comma-separated): planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done"
        ),
      assignee: z.string().optional().describe("Filter by assignee username"),
      component: z.string().optional().describe("Filter by component name"),
      category: z.string().optional().describe("Filter by category: bug, doc, user-story, idea"),
    },
    async ({ project, status, assignee, component, category }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (assignee) filters.assignee = assignee;
      if (component) filters.component = component;
      if (category) filters.category = category;
      return json(await client.listTasks(proj._id, filters));
    }
  );

  server.tool(
    "get_task",
    "Get full task details by task key (e.g. 'CP-1')",
    { taskKey: z.string().describe("Task key (e.g. 'CP-1')") },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.getTask(projectId, taskId));
    }
  );

  server.tool(
    "create_task",
    "Create a new task in a project",
    {
      project: z.string().describe("Project key (e.g. 'CP')"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      difficulty: z.string().optional().describe("Difficulty: S, M, L, or XL"),
      component: z.string().optional().describe("Component name"),
      category: z.string().optional().describe("Category: bug, doc, user-story, idea"),
      assignee: z.string().optional().describe("Assignee username"),
      status: z.string().optional().describe("Initial status (default: planned)"),
      acceptanceCriteria: z
        .string()
        .optional()
        .describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
    },
    async ({ project, title, description, difficulty, component, category, assignee, status, acceptanceCriteria }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const data: Record<string, unknown> = { title };

      if (description) data.description = description;
      if (difficulty) data.difficulty = difficulty;
      if (component) data.component = component;
      if (category) data.category = category;
      if (status) data.status = status;
      if (acceptanceCriteria) data.acceptanceCriteria = acceptanceCriteria;

      if (assignee) {
        const users = (await client.listUsers()) as { username: string }[];
        const user = users.find((u) => u.username === assignee.toLowerCase());
        if (!user) throw new Error(`User "${assignee}" not found`);
        data.assignee = user.username;
      }

      return json(await client.createTask(proj._id, data));
    }
  );

  server.tool(
    "update_task",
    "Update an existing task's fields by task key",
    {
      taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
      title: z.string().optional(),
      description: z.string().optional(),
      difficulty: z.string().optional(),
      component: z.string().optional(),
      category: z.string().optional(),
      assignee: z.string().optional().describe("Assignee username. Empty string to unassign."),
      acceptanceCriteria: z
        .string()
        .optional()
        .describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
    },
    async ({ taskKey, title, description, difficulty, component, category, assignee, acceptanceCriteria }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      const data: Record<string, unknown> = {};

      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (difficulty !== undefined) data.difficulty = difficulty;
      if (component !== undefined) data.component = component;
      if (category !== undefined) data.category = category;
      if (acceptanceCriteria !== undefined) data.acceptanceCriteria = acceptanceCriteria;

      if (assignee !== undefined) {
        if (assignee) {
          const users = (await client.listUsers()) as { username: string }[];
          const user = users.find((u) => u.username === assignee.toLowerCase());
          if (!user) throw new Error(`User "${assignee}" not found`);
          data.assignee = user.username;
        } else {
          data.assignee = null;
        }
      }

      return json(await client.updateTask(projectId, taskId, data));
    }
  );

  server.tool(
    "change_task_status",
    "Change the status of a task. Valid: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done",
    {
      taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
      status: z.string().describe("New status"),
    },
    async ({ taskKey, status }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.changeTaskStatus(projectId, taskId, status));
    }
  );

  // --- Sprints ---

  server.tool(
    "list_sprints",
    "List all sprints in a project",
    { project: z.string().describe("Project key (e.g. 'CP')") },
    async ({ project }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.listSprints(proj._id));
    }
  );

  server.tool(
    "create_sprint",
    "Create a new sprint in a project",
    {
      project: z.string().describe("Project key (e.g. 'CP')"),
      name: z.string().describe("Sprint name"),
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().describe("End date (YYYY-MM-DD)"),
      goal: z.string().optional().describe("Sprint goal"),
    },
    async ({ project, name, startDate, endDate, goal }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      return json(await client.createSprint(proj._id, { name, startDate, endDate, goal }));
    }
  );

  server.tool(
    "update_sprint",
    "Update an existing sprint (name, dates, goal, status)",
    {
      project: z.string().describe("Project key (e.g. 'CP')"),
      sprintId: z.string().describe("Sprint ID"),
      name: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      goal: z.string().optional(),
      status: z.string().optional().describe("planned, active, or completed"),
    },
    async ({ project, sprintId, name, startDate, endDate, goal, status }, extra) => {
      const client = clientFrom(extra);
      const proj = await client.getProjectByKey(project);
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (startDate !== undefined) updates.startDate = startDate;
      if (endDate !== undefined) updates.endDate = endDate;
      if (goal !== undefined) updates.goal = goal;
      if (status !== undefined) updates.status = status;
      return json(await client.updateSprint(proj._id, sprintId, updates));
    }
  );

  // --- Comments ---

  server.tool(
    "add_comment",
    "Add a comment to a task by task key (e.g. 'CP-1')",
    {
      taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
      body: z.string().describe("Comment text"),
    },
    async ({ taskKey, body }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.addComment(projectId, taskId, body));
    }
  );

  server.tool(
    "list_comments",
    "List all comments on a task by task key (e.g. 'CP-1')",
    { taskKey: z.string().describe("Task key (e.g. 'CP-1')") },
    async ({ taskKey }, extra) => {
      const client = clientFrom(extra);
      const { projectId, taskId } = await client.resolveTaskKey(taskKey);
      return json(await client.listComments(projectId, taskId));
    }
  );
}
