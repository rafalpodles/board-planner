import { ApiClient } from "../api-client.js";

interface Project {
  _id: string;
  key: string;
}

interface Task {
  _id: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  difficulty: string;
  component: string;
  category: string;
  status: string;
  assignee: { username: string; fullName: string } | null;
  acceptanceCriteria: string;
}

interface User {
  _id: string;
  username: string;
}

async function resolveTaskKey(
  client: ApiClient,
  taskKey: string
): Promise<{ projectId: string; task: Task }> {
  const match = taskKey.match(/^([A-Z]+)-(\d+)$/);
  if (!match) throw new Error(`Invalid task key format: "${taskKey}". Expected format: "CP-1"`);

  const [, projectKey, taskNumberStr] = match;
  const project = (await client.getProjectByKey(projectKey)) as Project;
  const tasks = (await client.listTasks(project._id)) as Task[];
  const task = tasks.find((t) => t.taskNumber === parseInt(taskNumberStr, 10));

  if (!task) throw new Error(`Task ${taskKey} not found`);

  return { projectId: project._id, task };
}

async function resolveAssignee(
  client: ApiClient,
  username: string
): Promise<string> {
  const users = (await client.listUsers()) as User[];
  const user = users.find((u) => u.username === username.toLowerCase());
  if (!user) throw new Error(`User "${username}" not found`);
  return user._id;
}

export function getTaskTools(client: ApiClient) {
  return {
    list_tasks: {
      description:
        "List tasks in a project with optional filters. Returns task keys, titles, statuses, and assignees.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project key (e.g. 'CP')",
          },
          status: {
            type: "string",
            description:
              "Filter by status (comma-separated). Values: planned, todo, in_progress, in_review, ready_to_test, in_testing, done",
          },
          assignee: {
            type: "string",
            description: "Filter by assignee username",
          },
          component: {
            type: "string",
            description: "Filter by component name",
          },
          category: {
            type: "string",
            description: "Filter by category: bug, doc, user-story, idea",
          },
        },
        required: ["project"],
      },
      handler: async (args: {
        project: string;
        status?: string;
        assignee?: string;
        component?: string;
        category?: string;
      }) => {
        const proj = (await client.getProjectByKey(args.project)) as Project;
        const filters: Record<string, string> = {};
        if (args.status) filters.status = args.status;
        if (args.assignee) filters.assignee = args.assignee;
        if (args.component) filters.component = args.component;
        if (args.category) filters.category = args.category;

        const tasks = (await client.listTasks(proj._id, filters)) as Task[];
        return tasks.map((t) => ({
          key: t.taskKey,
          title: t.title,
          status: t.status,
          difficulty: t.difficulty,
          category: t.category,
          component: t.component,
          assignee: t.assignee?.username || null,
        }));
      },
    },

    get_task: {
      description:
        "Get full task details by task key (e.g. 'CP-1'). Returns all fields including description and acceptance criteria.",
      inputSchema: {
        type: "object" as const,
        properties: {
          taskKey: {
            type: "string",
            description: "Task key (e.g. 'CP-1')",
          },
        },
        required: ["taskKey"],
      },
      handler: async (args: { taskKey: string }) => {
        const { task } = await resolveTaskKey(client, args.taskKey);
        return task;
      },
    },

    create_task: {
      description:
        "Create a new task in a project. Returns the created task with its key.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: {
            type: "string",
            description: "Project key (e.g. 'CP')",
          },
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          difficulty: {
            type: "string",
            description: "Difficulty: S, M, L, or XL",
          },
          component: { type: "string", description: "Component name" },
          category: {
            type: "string",
            description: "Category: bug, doc, user-story, or idea",
          },
          assignee: {
            type: "string",
            description: "Assignee username (not ID)",
          },
          status: {
            type: "string",
            description: "Initial status. Default: planned",
          },
          acceptanceCriteria: {
            type: "string",
            description: "Acceptance criteria text",
          },
        },
        required: ["project", "title"],
      },
      handler: async (args: {
        project: string;
        title: string;
        description?: string;
        difficulty?: string;
        component?: string;
        category?: string;
        assignee?: string;
        status?: string;
        acceptanceCriteria?: string;
      }) => {
        const proj = (await client.getProjectByKey(args.project)) as Project;
        const data: Record<string, unknown> = {
          title: args.title,
        };

        if (args.description) data.description = args.description;
        if (args.difficulty) data.difficulty = args.difficulty;
        if (args.component) data.component = args.component;
        if (args.category) data.category = args.category;
        if (args.status) data.status = args.status;
        if (args.acceptanceCriteria) data.acceptanceCriteria = args.acceptanceCriteria;

        if (args.assignee) {
          data.assignee = await resolveAssignee(client, args.assignee);
        }

        return client.createTask(proj._id, data);
      },
    },

    update_task: {
      description: "Update an existing task's fields by task key.",
      inputSchema: {
        type: "object" as const,
        properties: {
          taskKey: {
            type: "string",
            description: "Task key (e.g. 'CP-1')",
          },
          title: { type: "string" },
          description: { type: "string" },
          difficulty: { type: "string" },
          component: { type: "string" },
          category: { type: "string" },
          assignee: {
            type: "string",
            description: "Assignee username (not ID). Set empty to unassign.",
          },
          acceptanceCriteria: { type: "string" },
        },
        required: ["taskKey"],
      },
      handler: async (args: {
        taskKey: string;
        title?: string;
        description?: string;
        difficulty?: string;
        component?: string;
        category?: string;
        assignee?: string;
        acceptanceCriteria?: string;
      }) => {
        const { projectId, task } = await resolveTaskKey(client, args.taskKey);
        const data: Record<string, unknown> = {};

        if (args.title !== undefined) data.title = args.title;
        if (args.description !== undefined) data.description = args.description;
        if (args.difficulty !== undefined) data.difficulty = args.difficulty;
        if (args.component !== undefined) data.component = args.component;
        if (args.category !== undefined) data.category = args.category;
        if (args.acceptanceCriteria !== undefined)
          data.acceptanceCriteria = args.acceptanceCriteria;

        if (args.assignee !== undefined) {
          data.assignee = args.assignee
            ? await resolveAssignee(client, args.assignee)
            : null;
        }

        return client.updateTask(projectId, task._id, data);
      },
    },

    change_task_status: {
      description:
        "Change the status of a task. Valid statuses: planned, todo, in_progress, in_review, ready_to_test, in_testing, done",
      inputSchema: {
        type: "object" as const,
        properties: {
          taskKey: {
            type: "string",
            description: "Task key (e.g. 'CP-1')",
          },
          status: {
            type: "string",
            description:
              "New status: planned, todo, in_progress, in_review, ready_to_test, in_testing, done",
          },
        },
        required: ["taskKey", "status"],
      },
      handler: async (args: { taskKey: string; status: string }) => {
        const { projectId, task } = await resolveTaskKey(client, args.taskKey);
        return client.changeTaskStatus(projectId, task._id, args.status);
      },
    },
  };
}
