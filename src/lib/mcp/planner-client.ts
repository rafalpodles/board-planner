import type { ApiCustomField, ApiProjectCategory, ApiProjectColumn } from "@/types";
import { echo } from "@/lib/echo";
import { isValidProjectKey } from "@/lib/identifiers";
/** Only what the tools read: the id, and the field definitions the `fields` parameter resolves against */
export interface McpProject {
  _id: string;
  /** Whether the caller administers the board: what the app gates run history on */
  canAdmin?: boolean;
  customFields?: ApiCustomField[];
  categories?: ApiProjectCategory[];
  columns?: ApiProjectColumn[];
  /** Only the single-project read carries these: where the repository is, and whether a token is stored (never the token) */
  repositoryUrl?: string;
  repositoryProvider?: "github" | "gitlab" | "";
  githubTokenSet?: boolean;
  gitlabTokenSet?: boolean;
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
  // What one tool call looks up more than once — the board list, a roster, a board's sprints — is asked for
  // once. A client lives for one call (see clientFrom), so nothing here outlives the call it was made for
  private memo = new Map<string, Promise<unknown>>();

  private remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    let found = this.memo.get(key) as Promise<T> | undefined;
    if (!found) {
      found = load();
      this.memo.set(key, found);
      found.catch(() => this.memo.delete(key));
    }
    return found;
  }

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
    return this.remember("projects", () => this.request("GET", "/api/projects") as Promise<unknown[]>);
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

  /** One page of the board, with the total the filter matches. `fields` repeat as `field=<id>:<value>`. */
  async pageTasks(
    projectId: string,
    filters: Record<string, string>,
    fields: string[] = []
  ): Promise<{ tasks: unknown[]; total: number; limit: number; offset: number }> {
    const params = new URLSearchParams(filters);
    for (const field of fields) params.append("field", field);
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks?${params}`) as Promise<{
      tasks: unknown[];
      total: number;
      limit: number;
      offset: number;
    }>;
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

  async archiveTask(projectId: string, taskId: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/archive`, {});
  }

  async unarchiveTask(projectId: string, taskId: string): Promise<unknown> {
    return this.request("DELETE", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/archive`);
  }

  async deleteTask(projectId: string, taskId: string): Promise<unknown> {
    return this.request("DELETE", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}`);
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

  async addChecklistItem(
    projectId: string,
    taskId: string,
    item: { text: string; done: boolean }
  ): Promise<{ checklist: { _id: string; text: string; done: boolean }[] }> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/checklist`, item)) as never;
  }

  async setChecklistItem(
    projectId: string,
    taskId: string,
    itemId: string,
    change: { text?: string; done?: boolean }
  ): Promise<{ checklist: { _id: string; text: string; done: boolean }[] }> {
    return (await this.request(
      "PATCH",
      `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/checklist/${seg(itemId)}`,
      change
    )) as never;
  }

  async removeChecklistItem(
    projectId: string,
    taskId: string,
    itemId: string
  ): Promise<{ checklist: { _id: string; text: string; done: boolean }[] }> {
    return (await this.request(
      "DELETE",
      `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/checklist/${seg(itemId)}`
    )) as never;
  }

  async listComments(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`) as Promise<unknown[]>;
  }

  async editComment(projectId: string, taskId: string, commentId: string, body: string): Promise<unknown> {
    return this.request(
      "PUT",
      `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments/${seg(commentId)}`,
      { body }
    );
  }

  async deleteComment(projectId: string, taskId: string, commentId: string): Promise<unknown> {
    return this.request("DELETE", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments/${seg(commentId)}`);
  }

  async getTaskActivity(projectId: string, taskId: string): Promise<unknown[]> {
    return this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/activity`) as Promise<unknown[]>;
  }

  async addComment(projectId: string, taskId: string, body: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/comments`, { body });
  }

  async listSprints(projectId: string): Promise<unknown[]> {
    return this.remember(
      `sprints:${projectId}`,
      () => this.request("GET", `/api/projects/${seg(projectId)}/sprints`) as Promise<unknown[]>
    );
  }

  async createSprint(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    this.memo.delete(`sprints:${projectId}`);
    return this.request("POST", `/api/projects/${seg(projectId)}/sprints`, data);
  }

  async updateSprint(projectId: string, sprintId: string, data: Record<string, unknown>): Promise<unknown> {
    this.memo.delete(`sprints:${projectId}`);
    return this.request("PUT", `/api/projects/${seg(projectId)}/sprints/${seg(sprintId)}`, data);
  }

  async deleteSprint(projectId: string, sprintId: string): Promise<unknown> {
    this.memo.delete(`sprints:${projectId}`);
    return this.request("DELETE", `/api/projects/${seg(projectId)}/sprints/${seg(sprintId)}`);
  }

  async listAssignableUsers(projectId: string): Promise<unknown[]> {
    return this.remember(
      `members:${projectId}`,
      () => this.request("GET", `/api/projects/${seg(projectId)}/assignable-users`) as Promise<unknown[]>
    );
  }

  /** Sets the caller's watch to the state asked for; the route does it in one update, so a retry cannot undo it. */
  async setWatching(projectId: string, taskId: string, watching: boolean): Promise<{ watching: boolean }> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/watch`, {
      watching,
    })) as { watching: boolean };
  }

  /** The caller's own account, for whoami. Never handed on whole: it carries an address. */
  async getMe(): Promise<{ username: string; fullName?: string; role?: string }> {
    return (await this.request("GET", "/api/auth/me")) as { username: string; fullName?: string; role?: string };
  }

  async listMyTasks(): Promise<unknown[]> {
    return (await this.request("GET", "/api/tasks/mine")) as unknown[];
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

  async addCustomField(projectId: string, field: Record<string, unknown>): Promise<ApiCustomField[]> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/custom-fields`, field)) as ApiCustomField[];
  }

  async addFieldOption(
    projectId: string,
    fieldId: string,
    option: { value: string; color?: string }
  ): Promise<{ option: { id: string; value: string; color: string }; field: ApiCustomField }> {
    return (await this.request(
      "POST",
      `/api/projects/${seg(projectId)}/custom-fields/${seg(fieldId)}/options`,
      option
    )) as never;
  }

  async addCategory(projectId: string, category: { name: string; color?: string }): Promise<ApiProjectCategory[]> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/categories`, category)) as ApiProjectCategory[];
  }

  async addColumn(
    projectId: string,
    column: { label: string; role: string; color?: string }
  ): Promise<ApiProjectColumn[]> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/columns`, column)) as ApiProjectColumn[];
  }

  async renameColumn(projectId: string, columnId: string, label: string): Promise<ApiProjectColumn[]> {
    return (await this.request(
      "PATCH",
      `/api/projects/${seg(projectId)}/columns/${seg(columnId)}`,
      { label }
    )) as ApiProjectColumn[];
  }

  async syncRepository(projectId: string, provider: "github" | "gitlab"): Promise<Record<string, unknown>> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/${provider}/sync`, {})) as Record<string, unknown>;
  }

  /** The page a person opens for this task: what a minimal answer hands back so the work can be found. */
  taskUrl(taskKey: string): string {
    const cut = taskKey.lastIndexOf("-");
    return `${this.baseUrl}/projects/${seg(taskKey.slice(0, cut).toUpperCase())}/tasks/${seg(taskKey.slice(cut + 1))}`;
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
      ? ((await this.listTasks(project._id, { taskNumber: String(taskNumber), archived: "include" })) as {
          _id: string;
          taskNumber: number;
        }[]).find((t) => t.taskNumber === taskNumber)
      : undefined;

    if (!task) throw new Error(`Task ${echo(taskKey.toUpperCase())} not found`);
    return { projectId: project._id, taskId: task._id };
  }
}
