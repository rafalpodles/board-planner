import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "./api-client.js";
import {
  strictInput,
  NOTHING_TO_CHANGE,
  CREATE_TASK_HINTS,
  UPDATE_TASK_HINTS,
  CHANGE_STATUS_HINTS,
} from "./strict-input.js";

const APP_NAME = "Board Planner";

/**
 * Separated from the stdio bootstrap so the tools can be driven by a test. index.ts connects a
 * transport at import time, which made this half of BP-497's fix assertable only by reading its
 * source text — and a local shim named strictInput would have passed that scan (BP-497 review).
 */
export function registerTools(server: McpServer, client: ApiClient): void {
  // --- Project tools ---

  server.registerTool(
    "list_projects",
    {
      description: `List all projects in ${APP_NAME}`,
      inputSchema: strictInput({}),
    },
    async () => {
      const projects = await client.listProjects();
      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    }
  );

  server.registerTool(
    "get_project",
    {
      description: "Get project details by project key (e.g. 'CP') or project ID",
      inputSchema: strictInput({ identifier: z.string().describe("Project key (e.g. 'CP') or project ID") }),
    },
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

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks in a project with optional filters",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        status: z.string().optional().describe("Filter by status (comma-separated): the project's column ids — get_project lists them (defaults: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done)"),
        assignee: z.string().optional().describe("Filter by assignee username"),
        category: z.string().optional().describe("Filter by category (project-defined; defaults: bug, doc, user-story, idea)"),
        priority: z.string().optional().describe("Filter by priority: low, medium, high, urgent"),
      }),
    },
    async ({ project, status, assignee, category, priority }) => {
      const proj = await client.getProjectByKey(project) as { _id: string };
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (assignee) filters.assignee = assignee;
      if (category) filters.category = category;
      if (priority) filters.priority = priority;

      const tasks = await client.listTasks(proj._id, filters);
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Get full task details by task key (e.g. 'CP-1')",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }),
    },
    async ({ taskKey }) => {
      const { projectId, task } = await resolveTaskKey(taskKey);
      const fullTask = await client.getTask(projectId, (task as { _id: string })._id);
      return { content: [{ type: "text", text: JSON.stringify(fullTask, null, 2) }] };
    }
  );

  type FieldDef = {
    _id: string;
    name: string;
    fieldType: string;
    options?: (string | { id: string; value: string })[];
    archived?: boolean;
  };

  /**
   * Maps { "Difficulty": "L" } onto { <fieldId>: <optionId> }. Callers name fields and
   * options the way they read them; the API only ever stores ids.
   */
  function resolveFieldsByName(
    input: Record<string, unknown>,
    definitions: FieldDef[]
  ): Record<string, unknown> {
    const byName = new Map(
      (definitions || []).filter((f) => !f.archived).map((f) => [f.name.toLowerCase(), f])
    );
    const values: Record<string, unknown> = {};

    for (const [name, raw] of Object.entries(input || {})) {
      const field = byName.get(name.trim().toLowerCase());
      if (!field) {
        const known = [...byName.values()].map((f) => f.name).join(", ") || "none";
        throw new Error(`Unknown field "${name}". Available: ${known}`);
      }

      if (field.fieldType === "dropdown" || field.fieldType === "multiselect") {
        const options = (field.options || []).map((o) =>
          typeof o === "string" ? { id: o, value: o } : o
        );
        const resolve = (value: unknown) => {
          const text = String(value).trim().toLowerCase();
          const match =
            options.find((o) => o.id.toLowerCase() === text) ||
            options.find((o) => o.value.trim().toLowerCase() === text);
          if (!match) {
            const known = options.map((o) => o.value).join(", ") || "none";
            throw new Error(`Unknown option "${value}" for "${field.name}". Available: ${known}`);
          }
          return match.id;
        };
        values[field._id] = Array.isArray(raw) ? raw.map(resolve) : resolve(raw);
      } else {
        values[field._id] = raw;
      }
    }
    return values;
  }

  server.registerTool(
    "create_task",
    {
      description: "Create a new task in a project",
      inputSchema: strictInput({
        project: z.string().describe("Project key (e.g. 'CP')"),
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        priority: z.string().optional().describe("Priority: low, medium, high, or urgent (default: medium)"),
        category: z.string().optional().describe("Category — one of the project's configured categories (defaults: bug, doc, user-story, idea)"),
        assignee: z.string().optional().describe("Assignee username"),
        status: z.string().optional().describe("Initial status — one of the project's column ids, get_project lists them (default: the board's first backlog column)"),
        acceptanceCriteria: z.string().optional().describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
        fields: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name, e.g. { \"Difficulty\": \"L\", \"Component\": \"ui\" }. " +
              "Since CP-214 this is the only way to set them — see get_project for the field list."
          ),
      }, { hints: CREATE_TASK_HINTS, writes: true }),
    },
    async ({ project, title, description, priority, category, assignee, status, acceptanceCriteria, fields }) => {
      const proj = await client.getProjectByKey(project) as { _id: string; customFields?: FieldDef[] };
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
        // Scoped to the board, not the instance. A username that is not on this list may be a typo or
        // somebody with no access, and the two are deliberately NOT told apart: doing so would mean
        // answering "does this account exist elsewhere", which is the instance-wide roster BP-400 removed.
        const users = await client.listAssignableUsers(proj._id) as { _id: string; username: string }[];
        const user = users.find(u => u.username === assignee.toLowerCase());
        if (!user) throw new Error(`"${assignee}" is not someone this board can be assigned to — only people with access to it are.`);
        data.assignee = user.username;
      }

      const created = await client.createTask(proj._id, data);
      return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
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
              "what a task somebody is doing by hand looks like. A project agent may be chosen by " +
              "anyone who can edit the task; a personal agent only by its owner, and only onto their " +
              "own task (refused otherwise, dropped again when the task is handed on); a global " +
              "agent isn't scoped to either, so the same anyone-who-can-edit-the-task rule covers " +
              "it too; an agent with no steps is refused."
          ),
        acceptanceCriteria: z.string().optional().describe("Acceptance criteria (markdown checklist, converted to structured checklist items)"),
        fields: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Project-defined fields keyed by field name, e.g. { \"Difficulty\": \"L\", \"Component\": \"ui\" }. " +
              "Since CP-214 this is the only way to set them — see get_project for the field list."
          ),
      }, { hints: UPDATE_TASK_HINTS, writes: true }),
    },
    async ({ taskKey, title, description, priority, category, assignee, agent, acceptanceCriteria, fields }) => {
      // Before the lookup, so a call that changes nothing costs nothing and the refusal is the
      // first thing that happens rather than the last
      if (
        ![title, description, priority, category, assignee, agent, acceptanceCriteria].some(
          (v) => v !== undefined
        ) &&
        !Object.keys(fields || {}).length
      ) {
        throw new Error(`update_task ${NOTHING_TO_CHANGE}`);
      }

      const { projectId, task } = await resolveTaskKey(taskKey);
      const data: Record<string, unknown> = {};

      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (category !== undefined) data.category = category;
      if (acceptanceCriteria !== undefined) data.acceptanceCriteria = acceptanceCriteria;
      if (fields && Object.keys(fields).length) {
        // customFieldValues is replaced wholesale, so the task's other values are
        // merged back in rather than cleared by naming a single field
        const project = await client.getProject(projectId) as { customFields?: FieldDef[] };
        const current = ((task as { customFieldValues?: Record<string, unknown> }).customFieldValues) || {};
        data.customFieldValues = { ...current, ...resolveFieldsByName(fields, project.customFields || []) };
      }

      if (assignee !== undefined) {
        if (assignee) {
          // See create_task: the roster is the board's, and a miss is not split into typo vs no-access.
          const users = await client.listAssignableUsers(projectId) as { _id: string; username: string }[];
          const user = users.find(u => u.username === assignee.toLowerCase());
          if (!user) throw new Error(`"${assignee}" is not someone this board can be assigned to — only people with access to it are.`);
          data.assignee = user.username;
        } else {
          data.assignee = null;
        }
      }

      // Resolved by name here rather than asking a caller for an ObjectId, the same way assignee is:
      // the id appears in no MCP response, so demanding one would make the parameter unreachable
      // from a conversation.
      if (agent !== undefined) {
        if (agent) {
          const agents = await client.listAgents() as { _id: string; name: string }[];
          const match = agents.find(a => a.name.toLowerCase() === agent.toLowerCase());
          if (!match) throw new Error(`Agent "${agent}" not found`);
          data.agent = match._id;
        } else {
          data.agent = null;
        }
      }

      // Backstop for a call that named `fields` but no field in it. The refusal above catches
      // everything else, before the lookup
      if (Object.keys(data).length === 0) throw new Error(`update_task ${NOTHING_TO_CHANGE}`);

      const updated = await client.updateTask(projectId, (task as { _id: string })._id, data);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
  );

  server.registerTool(
    "change_task_status",
    {
      description: "Change the status of a task. Statuses are the project's column ids (defaults: planned, todo, in_progress, in_review, needs_human_review, ready_to_test, done — see get_project for the actual list with roles)",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        status: z.string().describe("New status"),
      }, { hints: CHANGE_STATUS_HINTS, writes: true }),
    },
    async ({ taskKey, status }) => {
      const { projectId, task } = await resolveTaskKey(taskKey);
      const updated = await client.changeTaskStatus(projectId, (task as { _id: string })._id, status);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
  );

  // --- Sprint tools ---

  server.registerTool(
    "list_sprints",
    {
      description: "List all sprints in a project",
      inputSchema: strictInput({ project: z.string().describe("Project key (e.g. 'CP')") }),
    },
    async ({ project }) => {
      const proj = await client.getProjectByKey(project) as { _id: string };
      const sprints = await client.listSprints(proj._id);
      return { content: [{ type: "text", text: JSON.stringify(sprints, null, 2) }] };
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
    async ({ project, name, startDate, endDate, goal }) => {
      const proj = await client.getProjectByKey(project) as { _id: string };
      const sprint = await client.createSprint(proj._id, { name, startDate, endDate, goal });
      return { content: [{ type: "text", text: JSON.stringify(sprint, null, 2) }] };
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
    async ({ project, sprintId, ...data }) => {
      if (![data.name, data.startDate, data.endDate, data.goal, data.status].some((v) => v !== undefined)) {
        throw new Error(`update_sprint ${NOTHING_TO_CHANGE}`);
      }

      const proj = await client.getProjectByKey(project) as { _id: string };
      const updates: Record<string, unknown> = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.startDate !== undefined) updates.startDate = data.startDate;
      if (data.endDate !== undefined) updates.endDate = data.endDate;
      if (data.goal !== undefined) updates.goal = data.goal;
      if (data.status !== undefined) updates.status = data.status;
      if (Object.keys(updates).length === 0) throw new Error(`update_sprint ${NOTHING_TO_CHANGE}`);

      const sprint = await client.updateSprint(proj._id, sprintId, updates);
      return { content: [{ type: "text", text: JSON.stringify(sprint, null, 2) }] };
    }
  );

  // --- Comment tools ---

  server.registerTool(
    "add_comment",
    {
      description: "Add a comment to a task by task key (e.g. 'CP-1')",
      inputSchema: strictInput({
        taskKey: z.string().describe("Task key (e.g. 'CP-1')"),
        body: z.string().describe("Comment text"),
      }, { writes: true }),
    },
    async ({ taskKey, body }) => {
      const { projectId, task } = await resolveTaskKey(taskKey);
      const comment = await client.addComment(projectId, (task as { _id: string })._id, body);
      return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
    }
  );

  server.registerTool(
    "list_comments",
    {
      description: "List all comments on a task by task key (e.g. 'CP-1')",
      inputSchema: strictInput({ taskKey: z.string().describe("Task key (e.g. 'CP-1')") }),
    },
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

}
