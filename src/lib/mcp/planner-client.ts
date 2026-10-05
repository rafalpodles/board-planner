import type { ApiCustomField } from "@/types";
import { echo } from "@/lib/echo";
import { isValidProjectKey } from "@/lib/identifiers";
/** Only what the tools read: the id, and the field definitions the `fields` parameter resolves against */
export interface McpProject {
  _id: string;
  customFields?: ApiCustomField[];
}

/**
 * A tool argument becomes a path segment, so it has to be encoded: the WHATWG parser normalises
 * `..` away, which let a tool argument choose the path the server fetched rather than the
 * resource it named (BP-316).
 *
 * Encoding alone does not do it. `encodeURIComponent` escapes `/` but leaves dots untouched, so a
 * bare `..` — the exact input this guard is named after — passed through and dropped the
 * `projects/<id>` segment, and with it the per-project scoping (BP-339).
 *
 * An allowlist rather than the three values that turned out to be dangerous: enumerating those is
 * the shape that failed here once already. Everything that reaches this is a Mongo ObjectId or a
 * project key, and `get_project` — the one tool taking a free-form identifier — already falls back
 * to a key lookup when this throws.
 *
 * The `typeof` is a boundary check, not part of the guard: values arrive from JSON despite the
 * signature, and `RegExp.test` would coerce them. It carries no security weight on its own — the
 * allowlist already refuses anything a coerced value could stringify into — and removing it leaves
 * the suite green. It stays so a `Symbol` reports this error instead of a coercion TypeError.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const seg = (value: string) => {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
    throw new Error(`Invalid path segment: "${echo(value)}"`);
  }
  return encodeURIComponent(value);
};

export class PlannerClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  async listProjects(): Promise<unknown[]> {
    return this.request("GET", "/api/projects") as Promise<unknown[]>;
  }

  async getProject(id: string): Promise<McpProject> {
    return (await this.request("GET", `/api/projects/${seg(id)}`)) as McpProject;
  }

  async getProjectByKey(key: string): Promise<McpProject> {
    const projects = await this.listProjects();
    const project = projects.find((p) => (p as { key: string }).key === key.toUpperCase());
    if (!project) throw new Error(`Project with key "${echo(key)}" not found`);
    return project as McpProject;
  }

  async listTasks(projectId: string, filters?: Record<string, string>): Promise<unknown[]> {
    const params = new URLSearchParams(filters || {}).toString();
    const query = params ? `?${params}` : "";
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks${query}`) as Promise<unknown[]>;
  }

  async getTask(projectId: string, taskId: string): Promise<unknown> {
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}`);
  }

  async createTask(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks`, data);
  }

  async updateTask(projectId: string, taskId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}`, data);
  }

  async changeTaskStatus(projectId: string, taskId: string, status: string): Promise<unknown> {
    return this.request("PATCH", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/status`, { status });
  }

  async reorderTasks(projectId: string, taskIds: string[]): Promise<unknown> {
    return this.request("PUT", `/api/projects/${seg(projectId)}/tasks/reorder`, { order: taskIds });
  }

  async addTaskLink(
    projectId: string,
    taskId: string,
    targetTaskId: string,
    type: string
  ): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/links`, {
      taskId: targetTaskId,
      type,
    });
  }

  async removeTaskLink(
    projectId: string,
    taskId: string,
    targetTaskId: string,
    type: string
  ): Promise<unknown> {
    return this.request("DELETE", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/links`, {
      taskId: targetTaskId,
      type,
    });
  }

  async listComments(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`) as Promise<unknown[]>;
  }

  async addComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`, { body });
  }

  async listSprints(projectId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/sprints`) as Promise<unknown[]>;
  }

  async createSprint(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/sprints`, data);
  }

  async updateSprint(projectId: string, sprintId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${seg(projectId)}/sprints/${seg(sprintId)}`, data);
  }

  async listAssignableUsers(projectId: string): Promise<unknown[]> {
    return this.request(
      "GET",
      `/api/projects/${seg(projectId)}/assignable-users`
    ) as Promise<unknown[]>;
  }

  async searchTasks(query: string): Promise<unknown[]> {
    return (await this.request("GET", `/api/search?q=${encodeURIComponent(query)}`)) as unknown[];
  }

  async getProjectStats(projectId: string): Promise<Record<string, unknown>> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/stats`)) as Record<string, unknown>;
  }

  async listRuns(projectId: string, limit: number): Promise<unknown[]> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/runs?limit=${limit}`)) as unknown[];
  }

  async listNotifications(limit: number, before?: string): Promise<unknown[]> {
    const params = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
    return (await this.request("GET", `/api/notifications?${params}`)) as unknown[];
  }

  async markNotificationsRead(id?: string): Promise<unknown> {
    return this.request("PATCH", "/api/notifications/read", id ? { id } : {});
  }

  async listAgents(): Promise<unknown[]> {
    return this.request("GET", "/api/agents") as Promise<unknown[]>;
  }

  async resolveTaskKey(taskKey: string): Promise<{ projectId: string; taskId: string }> {
    // Split on the LAST hyphen: a project key may itself hold hyphens, underscores and digits
    const match = taskKey.match(/^(.+)-(\d+)$/);
    if (!match || !isValidProjectKey(match[1])) {
      throw new Error(`Invalid task key: "${echo(taskKey)}". Expected format: "CP-1"`);
    }

    const project = await this.getProjectByKey(match[1]);
    const taskNumber = Number(match[2]);
    // Zero and anything past what a counter reaches name no task, and the route refuses them as
    // malformed rather than as absent — so the answer a caller gets stays "not found"
    const lookable = taskNumber >= 1 && taskNumber <= 999_999_999;
    // The row is matched on its number rather than taken on trust: a server that does not know the
    // filter (a rolling deploy) answers with the whole board, and the first row is somebody else's task
    const task = lookable
      ? ((await this.listTasks(project._id, { taskNumber: String(taskNumber) })) as {
          _id: string;
          taskNumber: number;
        }[]).find((t) => t.taskNumber === taskNumber)
      : undefined;

    if (!task) throw new Error(`Task ${echo(taskKey.toUpperCase())} not found`);
    return { projectId: project._id, taskId: task._id };
  }
}
