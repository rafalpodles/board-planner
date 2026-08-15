// A tool argument becomes a path segment, so it has to be encoded: the WHATWG parser normalises
// `..` before the request goes out, so an id of `p1/../../admin/users` would otherwise fetch a
// route the tool never named. Kept identical to src/lib/mcp/planner-client.ts, which this file is
// a copy of — CI builds the two packages separately, so nothing flags a divergence (BP-316 review).
//
// Encoding is not enough on its own: it escapes `/` and leaves dots alone, so a bare `..` walked
// through and dropped the `projects/<id>` segment (BP-339).
const seg = (value: string) => {
  if (value === "" || value === "." || value === "..") {
    throw new Error(`Invalid path segment: "${value}"`);
  }
  return encodeURIComponent(value);
};

export class ApiClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, auth: { token: string }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader = `Bearer ${auth.token}`;
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
    return this.request("GET", `/api/projects/${seg(id)}`);
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

  // Comments
  async listComments(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`) as Promise<unknown[]>;
  }

  async addComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`, { body });
  }

  // Sprints
  async listSprints(projectId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/sprints`) as Promise<unknown[]>;
  }

  async createSprint(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/sprints`, data);
  }

  async updateSprint(projectId: string, sprintId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `/api/projects/${seg(projectId)}/sprints/${seg(sprintId)}`, data);
  }

  // Users
  async listUsers(): Promise<unknown[]> {
    return this.request("GET", "/api/users/list") as Promise<unknown[]>;
  }
}
