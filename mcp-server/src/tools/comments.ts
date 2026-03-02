import { ApiClient } from "../api-client.js";

interface Project {
  _id: string;
}

interface Task {
  _id: string;
  taskNumber: number;
}

export function getCommentTools(client: ApiClient) {
  async function resolveTaskKey(
    taskKey: string
  ): Promise<{ projectId: string; taskId: string }> {
    const match = taskKey.match(/^([A-Z]+)-(\d+)$/);
    if (!match)
      throw new Error(
        `Invalid task key format: "${taskKey}". Expected format: "CP-1"`
      );

    const [, projectKey, taskNumberStr] = match;
    const project = (await client.getProjectByKey(projectKey)) as Project;
    const tasks = (await client.listTasks(project._id)) as Task[];
    const task = tasks.find(
      (t) => t.taskNumber === parseInt(taskNumberStr, 10)
    );

    if (!task) throw new Error(`Task ${taskKey} not found`);
    return { projectId: project._id, taskId: task._id };
  }

  return {
    add_comment: {
      description: "Add a comment to a task by task key (e.g. 'CP-1')",
      inputSchema: {
        type: "object" as const,
        properties: {
          taskKey: {
            type: "string",
            description: "Task key (e.g. 'CP-1')",
          },
          body: {
            type: "string",
            description: "Comment text",
          },
        },
        required: ["taskKey", "body"],
      },
      handler: async (args: { taskKey: string; body: string }) => {
        const { projectId, taskId } = await resolveTaskKey(args.taskKey);
        return client.addComment(projectId, taskId, args.body);
      },
    },

    list_comments: {
      description: "List all comments on a task by task key (e.g. 'CP-1')",
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
        const { projectId, taskId } = await resolveTaskKey(args.taskKey);
        return client.listComments(projectId, taskId);
      },
    },
  };
}
