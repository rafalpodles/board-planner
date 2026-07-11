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

  async getProject(id: string): Promise<unknown> {
    return this.request("GET", `/api/projects/${id}`);
  }

  async getProjectByKey(key: string): Promise<{ _id: string }> {
    const projects = await this.listProjects();
    const project = projects.find((p) => (p as { key: string }).key === key.toUpperCase());
    if (!project) throw new Error(`Project with key "${key}" not found`);
    return project as { _id: string };
  }

  async listTasks(projectId: string, filters?: Record<string, string>): Promise<unknown[]> {
    const params = new URLSearchParams(filters || {}).toString();
    const query = params ? `?${params}` : "";
    return this.request("GET", `/api/projects/${projectId}/tasks${query}`) as Promise<unknown[]>;
  }

  async getTask(projectId: string, taskId: string): Promise<unknown> {
    return this.request("GET", `/api/projects/${projectId}/tasks/${taskId}`);
  }

  async createTask(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${projectId}/tasks`, data);
  }

  async updateTask(projectId: string, taskId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${projectId}/tasks/${taskId}`, data);
  }

  async changeTaskStatus(projectId: string, taskId: string, status: string): Promise<unknown> {
    return this.request("PATCH", `/api/projects/${projectId}/tasks/${taskId}/status`, { status });
  }

  async listComments(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${projectId}/tasks/${taskId}/comments`) as Promise<unknown[]>;
  }

  async addComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${projectId}/tasks/${taskId}/comments`, { body });
  }

  async listSprints(projectId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${projectId}/sprints`) as Promise<unknown[]>;
  }

  async createSprint(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${projectId}/sprints`, data);
  }

  async updateSprint(projectId: string, sprintId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${projectId}/sprints/${sprintId}`, data);
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
