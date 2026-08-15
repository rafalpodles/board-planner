import type { ApiCustomField } from "@/types";
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
 * to a key lookup when this throws. The `typeof` guard is not redundant: `RegExp.test` coerces, so
 * `[".."]` would otherwise pass and stringify back to a dot segment.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

const seg = (value: string) => {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) {
    throw new Error(`Invalid path segment: "${value}"`);
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
    if (!project) throw new Error(`Project with key "${key}" not found`);
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

  async listUsers(): Promise<unknown[]> {
    return this.request("GET", "/api/users/list") as Promise<unknown[]>;
  }

  async resolveTaskKey(taskKey: string): Promise<{ projectId: string; taskId: string }> {
    const match = taskKey.match(/^([A-Z]+)-(\d+)$/i);
    if (!match) throw new Error(`Invalid task key: "${taskKey}". Expected format: "CP-1"`);

    const [, projectKey, taskNumberStr] = match;
    const project = await this.getProjectByKey(projectKey);
    const tasks = (await this.listTasks(project._id)) as { _id: string; taskNumber: number }[];
    const task = tasks.find((t) => t.taskNumber === parseInt(taskNumberStr, 10));

    if (!task) throw new Error(`Task ${taskKey.toUpperCase()} not found`);
    return { projectId: project._id, taskId: task._id };
  }
}
