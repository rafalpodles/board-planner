export class ApiClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: this.authHeader,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  // Projects
  async listProjects(): Promise<unknown[]> {
    return this.request("GET", "/api/projects") as Promise<unknown[]>;
  }

  async getProject(id: string): Promise<unknown> {
    return this.request("GET", `/api/projects/${id}`);
  }

  async getProjectByKey(key: string): Promise<unknown> {
    const projects = await this.listProjects();
    const project = projects.find(
      (p) => (p as { key: string }).key === key.toUpperCase()
    );
    if (!project) throw new Error(`Project with key "${key}" not found`);
    return project;
  }

  // Tasks
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

  // Comments
  async listComments(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${projectId}/tasks/${taskId}/comments`) as Promise<unknown[]>;
  }

  async addComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${projectId}/tasks/${taskId}/comments`, { body });
  }

  // Sprints
  async listSprints(projectId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${projectId}/sprints`) as Promise<unknown[]>;
  }

  async createSprint(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${projectId}/sprints`, data);
  }

  async updateSprint(projectId: string, sprintId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${projectId}/sprints/${sprintId}`, data);
  }

  // Users
  async listUsers(): Promise<unknown[]> {
    return this.request("GET", "/api/users") as Promise<unknown[]>;
  }
}
