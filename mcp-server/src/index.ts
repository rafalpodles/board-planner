import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "./api-client.js";

const CLAUDEPLANNER_URL = process.env.CLAUDEPLANNER_URL || "http://localhost:3000";
const CLAUDEPLANNER_USERNAME = process.env.CLAUDEPLANNER_USERNAME;
const CLAUDEPLANNER_PASSWORD = process.env.CLAUDEPLANNER_PASSWORD;

if (!CLAUDEPLANNER_USERNAME || !CLAUDEPLANNER_PASSWORD) {
  console.error("CLAUDEPLANNER_USERNAME and CLAUDEPLANNER_PASSWORD environment variables are required");
  process.exit(1);
}

const client = new ApiClient(CLAUDEPLANNER_URL, CLAUDEPLANNER_USERNAME, CLAUDEPLANNER_PASSWORD);

const server = new McpServer({
  name: "claudeplanner",
  version: "1.0.0",
});

// --- Project tools ---

server.tool(
  "list_projects",
  "List all projects in ClaudePlanner",
  {},
  async () => {
    const projects = await client.listProjects();
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
  }
);

server.tool(
  "get_project",
  "Get project details by project key (e.g. 'CP') or project ID",
  { identifier: z.string().describe("Project key (e.g. 'CP') or project ID") },
  async ({ identifier }) => {
    let project;
    try {
      project = await client.getProject(identifier);
    } catch {
      project = await client.getProjectByKey(identifier);
    }
    return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
  }
);

// --- Task tools ---

server.tool(
  "list_tasks",
  "List tasks in a project with optional filters",
  {
    project: z.string().describe("Project key (e.g. 'CP')"),
    status: z.string().optional().describe("Filter by status (comma-separated): planned, todo, in_progress, in_review, ready_to_test, done"),
    assignee: z.string().optional().describe("Filter by assignee username"),
    component: z.string().optional().describe("Filter by component name"),
    category: z.string().optional().describe("Filter by category: bug, doc, user-story, idea"),
  },
  async ({ project, status, assignee, component, category }) => {
    const proj = await client.getProjectByKey(project) as { _id: string };
    const filters: Record<string, string> = {};
    if (status) filters.status = status;
    if (assignee) filters.assignee = assignee;
    if (component) filters.component = component;
    if (category) filters.category = category;

    const tasks = await client.listTasks(proj._id, filters);
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  }
);

server.tool(
  "get_task",
  "Get full task details by task key (e.g. 'CP-1')",
  { taskKey: z.string().describe("Task key (e.g. 'CP-1')") },
  async ({ taskKey }) => {
    const { projectId, task } = await resolveTaskKey(taskKey);
    const fullTask = await client.getTask(projectId, (task as { _id: string })._id);
    return { content: [{ type: "text", text: JSON.stringify(fullTask, null, 2) }] };
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
    acceptanceCriteria: z.string().optional().describe("Acceptance criteria"),
  },
  async ({ project, title, description, difficulty, component, category, assignee, status, acceptanceCriteria }) => {
    const proj = await client.getProjectByKey(project) as { _id: string };
    const data: Record<string, unknown> = { title };

    if (description) data.description = description;
    if (difficulty) data.difficulty = difficulty;
    if (component) data.component = component;
    if (category) data.category = category;
    if (status) data.status = status;
    if (acceptanceCriteria) data.acceptanceCriteria = acceptanceCriteria;

    if (assignee) {
      const users = await client.listUsers() as { _id: string; username: string }[];
      const user = users.find(u => u.username === assignee.toLowerCase());
      if (!user) throw new Error(`User "${assignee}" not found`);
      data.assignee = user._id;
    }

    const created = await client.createTask(proj._id, data);
    return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
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
    acceptanceCriteria: z.string().optional(),
  },
  async ({ taskKey, title, description, difficulty, component, category, assignee, acceptanceCriteria }) => {
    const { projectId, task } = await resolveTaskKey(taskKey);
    const data: Record<string, unknown> = {};

    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (difficulty !== undefined) data.difficulty = difficulty;
    if (component !== undefined) data.component = component;
    if (category !== undefined) data.category = category;
    if (acceptanceCriteria !== undefined) data.acceptanceCriteria = acceptanceCriteria;

    if (assignee !== undefined) {
      if (assignee) {
        const users = await client.listUsers() as { _id: string; username: string }[];
        const user = users.find(u => u.username === assignee.toLowerCase());
        if (!user) throw new Error(`User "${assignee}" not found`);
        data.assignee = user._id;
      } else {
        data.assignee = null;
      }
    }

    const updated = await client.updateTask(projectId, (task as { _id: string })._id, data);
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  }
);

server.tool(
  "change_task_status",
  "Change the status of a task. Valid: planned, todo, in_progress, in_review, ready_to_test, done",
  {
    taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
    status: z.string().describe("New status"),
  },
  async ({ taskKey, status }) => {
    const { projectId, task } = await resolveTaskKey(taskKey);
    const updated = await client.changeTaskStatus(projectId, (task as { _id: string })._id, status);
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  }
);

// --- Comment tools ---

server.tool(
  "add_comment",
  "Add a comment to a task by task key (e.g. 'CP-1')",
  {
    taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
    body: z.string().describe("Comment text"),
  },
  async ({ taskKey, body }) => {
    const { projectId, task } = await resolveTaskKey(taskKey);
    const comment = await client.addComment(projectId, (task as { _id: string })._id, body);
    return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
  }
);

server.tool(
  "list_comments",
  "List all comments on a task by task key (e.g. 'CP-1')",
  { taskKey: z.string().describe("Task key (e.g. 'CP-1')") },
  async ({ taskKey }) => {
    const { projectId, task } = await resolveTaskKey(taskKey);
    const comments = await client.listComments(projectId, (task as { _id: string })._id);
    return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
  }
);

// --- Helper ---

async function resolveTaskKey(taskKey: string): Promise<{ projectId: string; task: unknown }> {
  const match = taskKey.match(/^([A-Z]+)-(\d+)$/);
  if (!match) throw new Error(`Invalid task key: "${taskKey}". Expected format: "CP-1"`);

  const [, projectKey, taskNumberStr] = match;
  const project = await client.getProjectByKey(projectKey) as { _id: string };
  const tasks = await client.listTasks(project._id) as { _id: string; taskNumber: number }[];
  const task = tasks.find(t => t.taskNumber === parseInt(taskNumberStr, 10));

  if (!task) throw new Error(`Task ${taskKey} not found`);
  return { projectId: project._id, task };
}

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ClaudePlanner MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
