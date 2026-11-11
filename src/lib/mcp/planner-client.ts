import type {
  ApiAgent,
  ApiAgentBlock,
  ApiCustomField,
  ApiProjectCategory,
  ApiProjectColumn,
  ApiTaskTemplate,
  ApiTaskTriage,
} from "@/types";
import { echo } from "@/lib/echo";
import type { AnyColumn } from "@/lib/columns";
import { isValidProjectKey } from "@/lib/identifiers";
import { MCP_CLIENT_HEADER, MCP_CLIENT_VALUE } from "@/lib/activity-source";
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

export interface McpPerson {
  _id: string;
  username: string;
  fullName?: string;
}

export interface McpMember extends McpPerson {
  relation: string | null;
  source?: string;
  instanceAdmin?: boolean;
  deactivated?: boolean;
}

export interface GroupRoles {
  map: { group: string; role: string }[];
  hasProvider: boolean;
}

export interface PmMessageRow {
  role: string;
  content: string;
  createdAt?: string;
  actions?: { tool: string; taskKey?: string; summary?: string }[];
}

export interface PmTurn {
  ok: boolean;
  message: string;
  error?: string;
  interrupted?: boolean;
  actions: unknown[];
}

async function errorOf(res: Response): Promise<string> {
  const err = await res.json().catch(() => ({ error: res.statusText }));
  return (err as { error?: string }).error || `HTTP ${res.status}`;
}

function storedMessage(value: unknown): { content: string; actions?: unknown[] } {
  if (typeof value === "string") return { content: value };
  if (!value || typeof value !== "object") return { content: "" };
  const message = value as { content?: unknown; actions?: unknown };
  return {
    content: typeof message.content === "string" ? message.content : "",
    ...(Array.isArray(message.actions)
      ? {
          actions: message.actions.map((a: { tool?: string; taskKey?: string; summary?: string }) => ({
            tool: a.tool,
            ...(a.taskKey ? { taskKey: a.taskKey } : {}),
            ...(a.summary ? { summary: a.summary } : {}),
          })),
        }
      : {}),
  };
}

/** The events of one turn; comments (`: ping`) and the streamed text deltas are not part of the answer. */
export function readPmTurn(stream: string): PmTurn {
  const turn: PmTurn = { ok: false, message: "", actions: [] };
  let ended = false;
  for (const frame of stream.split("\n\n")) {
    let event = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (!event || data.length === 0) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      continue;
    }
    if (event === "action") turn.actions.push(payload);
    if (event === "done" || event === "error") {
      ended = true;
      turn.ok = event === "done";
      const stored = storedMessage(payload.message);
      turn.message = stored.content;
      if (stored.actions) turn.actions = stored.actions;
      if (event === "done") turn.interrupted = payload.interrupted === true;
      else turn.error = typeof payload.error === "string" ? payload.error : "The PM turn failed";
    }
  }
  if (!ended) turn.error = "The PM turn ended without an answer";
  return turn;
}

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

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      [MCP_CLIENT_HEADER]: MCP_CLIENT_VALUE,
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) throw new Error(await errorOf(res));

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

  async createProject(data: Record<string, unknown>): Promise<McpProject & { key: string; name: string }> {
    this.memo.delete("projects");
    return (await this.request("POST", "/api/projects", data)) as McpProject & { key: string; name: string };
  }

  async updateProject(projectId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.memo.delete("projects");
    return (await this.request("PUT", `/api/projects/${seg(projectId)}`, data)) as Record<string, unknown>;
  }

  async setDefaultAgent(projectId: string, agentId: string): Promise<unknown> {
    return this.request("PUT", `/api/projects/${seg(projectId)}/agent`, { agentId });
  }

  async listProjectMembers(projectId: string): Promise<McpMember[]> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/members`)) as McpMember[];
  }

  async findMemberCandidates(projectId: string, query: string): Promise<McpPerson[]> {
    const q = encodeURIComponent(query);
    return (await this.request("GET", `/api/projects/${seg(projectId)}/members/candidates?q=${q}`)) as McpPerson[];
  }

  async setMember(projectId: string, userId: string, relation: string): Promise<unknown> {
    this.memo.delete(`members:${projectId}`);
    return this.request("PUT", `/api/projects/${seg(projectId)}/members`, { userId, relation });
  }

  async removeMember(projectId: string, userId: string): Promise<unknown> {
    this.memo.delete(`members:${projectId}`);
    return this.request("DELETE", `/api/projects/${seg(projectId)}/members?userId=${seg(userId)}`);
  }

  async getGroupRoles(projectId: string): Promise<GroupRoles> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/group-roles`)) as GroupRoles;
  }

  async setGroupRoles(projectId: string, map: { group: string; role: string }[]): Promise<GroupRoles> {
    return (await this.request("PUT", `/api/projects/${seg(projectId)}/group-roles`, map)) as GroupRoles;
  }

  async createAgent(data: Record<string, unknown>): Promise<ApiAgent> {
    return (await this.request("POST", "/api/agents", data)) as ApiAgent;
  }

  async updateAgent(agentId: string, data: Record<string, unknown>): Promise<ApiAgent> {
    return (await this.request("PUT", `/api/agents/${seg(agentId)}`, data)) as ApiAgent;
  }

  async listAgentBlocks(): Promise<ApiAgentBlock[]> {
    return this.remember("agent-blocks", () => this.request("GET", "/api/agent-blocks") as Promise<ApiAgentBlock[]>);
  }

  async createAgentBlock(data: Record<string, unknown>): Promise<ApiAgentBlock> {
    this.memo.delete("agent-blocks");
    return (await this.request("POST", "/api/agent-blocks", data)) as ApiAgentBlock;
  }

  async updateAgentBlock(blockId: string, data: Record<string, unknown>): Promise<ApiAgentBlock> {
    this.memo.delete("agent-blocks");
    return (await this.request("PUT", `/api/agent-blocks/${seg(blockId)}`, data)) as ApiAgentBlock;
  }

  async deleteAgentBlock(blockId: string): Promise<unknown> {
    this.memo.delete("agent-blocks");
    return this.request("DELETE", `/api/agent-blocks/${seg(blockId)}`);
  }

  async replaceColumns(projectId: string, columns: AnyColumn[]): Promise<ApiProjectColumn[]> {
    return (await this.request("PUT", `/api/projects/${seg(projectId)}/columns`, { columns })) as ApiProjectColumn[];
  }

  async updateCustomField(projectId: string, fieldId: string, changes: Record<string, unknown>): Promise<ApiCustomField[]> {
    return (await this.request(
      "PATCH",
      `/api/projects/${seg(projectId)}/custom-fields/${seg(fieldId)}`,
      changes
    )) as ApiCustomField[];
  }

  async deleteCustomField(projectId: string, fieldId: string): Promise<ApiCustomField[]> {
    return (await this.request(
      "DELETE",
      `/api/projects/${seg(projectId)}/custom-fields/${seg(fieldId)}`
    )) as ApiCustomField[];
  }

  async updateCategory(
    projectId: string,
    change: { name: string; newName?: string; color?: string }
  ): Promise<ApiProjectCategory[]> {
    return (await this.request("PATCH", `/api/projects/${seg(projectId)}/categories`, change)) as ApiProjectCategory[];
  }

  async deleteCategory(projectId: string, name: string): Promise<ApiProjectCategory[]> {
    return (await this.request("DELETE", `/api/projects/${seg(projectId)}/categories`, { name })) as ApiProjectCategory[];
  }

  async addTemplate(projectId: string, template: Record<string, unknown>): Promise<ApiTaskTemplate[]> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/templates`, template)) as ApiTaskTemplate[];
  }

  async updateTemplate(projectId: string, templateId: string, changes: Record<string, unknown>): Promise<ApiTaskTemplate[]> {
    return (await this.request("PUT", `/api/projects/${seg(projectId)}/templates`, {
      templateId,
      ...changes,
    })) as ApiTaskTemplate[];
  }

  async deleteTemplate(projectId: string, templateId: string): Promise<ApiTaskTemplate[]> {
    return (await this.request("DELETE", `/api/projects/${seg(projectId)}/templates`, { templateId })) as ApiTaskTemplate[];
  }

  async getTriage(projectId: string, taskId: string): Promise<{ triage: ApiTaskTriage | null }> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/triage`)) as {
      triage: ApiTaskTriage | null;
    };
  }

  async actOnTriage(
    projectId: string,
    taskId: string,
    suggestionId: string,
    action: string
  ): Promise<{ triage: ApiTaskTriage | null }> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/tasks/${seg(taskId)}/triage`, {
      suggestionId,
      action,
    })) as { triage: ApiTaskTriage | null };
  }

  async findDuplicates(projectId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/duplicates`, query)) as Record<string, unknown>;
  }

  async draftTask(projectId: string, prompt: string): Promise<Record<string, unknown>> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/ai/generate-task`, { prompt })) as Record<
      string,
      unknown
    >;
  }

  async releaseNotes(projectId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/release-notes`, query)) as Record<string, unknown>;
  }

  async summarize(
    projectId: string,
    query: Record<string, unknown>
  ): Promise<{ markdown: string; noteDropped?: boolean; channels: number; sealed: string | null }> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/summaries`, query)) as never;
  }

  async postSummary(projectId: string, sealed: string): Promise<Record<string, unknown>> {
    return (await this.request("POST", `/api/projects/${seg(projectId)}/summaries/post`, { sealed })) as Record<
      string,
      unknown
    >;
  }

  async getInsights(projectId: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(query).toString();
    return (await this.request("GET", `/api/projects/${seg(projectId)}/insights${params ? `?${params}` : ""}`)) as Record<
      string,
      unknown
    >;
  }

  async startPmReview(projectId: string): Promise<unknown> {
    return this.request("POST", `/api/projects/${seg(projectId)}/pm/review`, {});
  }

  async pmUsage(projectId: string): Promise<Record<string, unknown>> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/pm/usage`)) as Record<string, unknown>;
  }

  /** One PM turn, read to its end: the route streams it as server-sent events and the tool answers once it is over. */
  async askPm(projectId: string, message: string, signal?: AbortSignal): Promise<PmTurn> {
    const res = await fetch(`${this.baseUrl}/api/projects/${seg(projectId)}/pm/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ message }),
      signal,
    });
    if (!res.ok) throw new Error(await errorOf(res));
    return readPmTurn(await res.text());
  }

  async pmMessages(projectId: string, limit: number): Promise<{ messages: PmMessageRow[] }> {
    return (await this.request("GET", `/api/projects/${seg(projectId)}/pm/messages?limit=${limit}`)) as {
      messages: PmMessageRow[];
    };
  }

  async listMyMachines(): Promise<Record<string, unknown>[]> {
    return (await this.request("GET", "/api/users/me/machines")) as Record<string, unknown>[];
  }

  projectUrl(projectKey: string): string {
    return `${this.baseUrl}/projects/${seg(projectKey.toUpperCase())}`;
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
