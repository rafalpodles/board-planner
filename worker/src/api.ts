import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { Bootstrap } from "./config.js";
import { Identity, loadIdentity, PROTOCOL_VERSION, Store } from "./registration.js";
import { RunRecord } from "./run-record.js";
import { AgentSnapshot, ClaimedTask, SnapshotEntry } from "./types.js";

type Fetch = typeof globalThis.fetch;

const NOT_REGISTERED_MESSAGE = "this worker is not registered — see worker/README.md";

export interface StatusIds {
  approved: string;
  review: string;
  done: string;
}

export interface PhaseEvent {
  taskId: string;
  runId: string;
  phase: string;
}

export interface ApiClient {
  claim(projectId: string, runId: string): Promise<ClaimedTask | null>;
  setStatus(projectId: string, taskId: string, status: string): Promise<void>;
  comment(projectId: string, taskId: string, body: string): Promise<void>;
  release(projectId: string, taskId: string, options?: { refund?: boolean }): Promise<void>;
  statusIds(projectId: string): Promise<StatusIds>;
  columnIds(projectId: string): Promise<string[]>;
  postEvent(event: PhaseEvent): Promise<{ applied: boolean }>;
  postRun(projectId: string, record: RunRecord): Promise<void>;
}

const SAFE_TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*-\d+$/;

function isSafeTaskKey(taskKey: string): boolean {
  return SAFE_TASK_KEY.test(taskKey);
}

interface RawTask {
  _id: string;
  project?: unknown;
  taskNumber: number;
  title: string;
  description: string;
  checklist?: Array<{ text?: unknown }>;
  execution?: { attempts?: number; runId?: unknown };
  agent?: unknown;
}

function parseEntry(value: unknown): SnapshotEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const key = typeof raw.key === "string" ? raw.key : "";
  const kind = raw.kind === "step" || raw.kind === "gate" ? raw.kind : null;
  if (!key || !kind) return null;

  const params: Record<string, string> = {};
  if (typeof raw.params === "object" && raw.params !== null) {
    for (const [name, value] of Object.entries(raw.params as Record<string, unknown>)) {
      if (typeof value === "string") params[name] = value;
    }
  }

  return {
    key,
    kind,
    name: typeof raw.name === "string" ? raw.name : key,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    capability: raw.capability === "edit" ? "edit" : "read-only",
    model: typeof raw.model === "string" ? raw.model : "",
    fallbackModel: typeof raw.fallbackModel === "string" ? raw.fallbackModel : "",
    deterministic: raw.deterministic === true,
    gateKind: typeof raw.gateKind === "string" ? raw.gateKind : "",
    params,
  };
}

function parseAgent(value: unknown): AgentSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sequence) || raw.sequence.length === 0) return null;

  const sequence = raw.sequence.map(parseEntry);
  if (sequence.some((entry) => entry === null)) return null;

  return {
    agentId: typeof raw.agentId === "string" ? raw.agentId : "",
    name: typeof raw.name === "string" ? raw.name : "",
    sequence: sequence as SnapshotEntry[],
  };
}

interface BoardColumn {
  id: string;
  role: string;
  order: number;
  triggersPmReview: boolean;
}

const SEEDED_BOARD: BoardColumn[] = [
  { id: "planned", role: "backlog", order: 0, triggersPmReview: false },
  { id: "todo", role: "approved", order: 1, triggersPmReview: false },
  { id: "in_progress", role: "active", order: 2, triggersPmReview: false },
  { id: "in_review", role: "review", order: 3, triggersPmReview: false },
  { id: "needs_human_review", role: "review", order: 4, triggersPmReview: true },
  { id: "ready_to_test", role: "review", order: 5, triggersPmReview: false },
  { id: "done", role: "done", order: 6, triggersPmReview: false },
];

function statusIdsFrom(columns: BoardColumn[]): StatusIds {
  const withRole = (role: string) => columns.filter((column) => column.role === role);
  const review = withRole("review");
  return {
    approved: withRole("approved")[0]?.id ?? "",
    review: (review.find((column) => column.triggersPmReview) ?? review[0])?.id ?? "",
    done: withRole("done")[0]?.id ?? "",
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ClaimRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ClaimRefused";
  }
}

const MAX_REASON_CHARS = 300;

function reasonIn(detail: string): string {
  let reason = "";
  try {
    const body = JSON.parse(detail) as { error?: unknown };
    if (typeof body.error === "string") reason = body.error;
  } catch {
    reason = detail;
  }
  reason = reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
  return reason || "the board refused the claim without saying why";
}

async function appliedFrom(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { applied?: unknown };
    return body.applied !== false;
  } catch {
    return true;
  }
}

function toColumn(value: unknown): BoardColumn | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.role !== "string") return null;
  return {
    id: raw.id,
    role: raw.role,
    order: typeof raw.order === "number" ? raw.order : 0,
    triggersPmReview: raw.triggersPmReview === true,
  };
}

function fileIdentityReader(stateDir: string): Pick<Store, "read"> {
  const path = join(stateDir, "worker.json");
  return {
    read: () => {
      if (!existsSync(path)) return "";
      const { mode } = statSync(path);
      if (mode & 0o077) {
        throw new Error(
          `${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`
        );
      }
      return readFileSync(path, "utf8");
    },
  };
}

export function createApiClient(
  config: Bootstrap,
  fetchImpl: Fetch = fetch,
  identitySource?: Pick<Store, "read">
): ApiClient {
  let warnedNotRegistered = false;

  function warnNotRegistered(): void {
    if (warnedNotRegistered) return;
    warnedNotRegistered = true;
    console.error(NOT_REGISTERED_MESSAGE);
  }

  function identityOrThrow(): Identity {
    const identity = loadIdentity(identitySource ?? fileIdentityReader(config.stateDir));
    if (!identity) {
      warnNotRegistered();
      throw new Error(NOT_REGISTERED_MESSAGE);
    }
    return identity;
  }

  async function request(path: string, method: string, body?: unknown): Promise<Response> {
    const identity = identityOrThrow();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${identity.credential}`,
      "X-Worker-Id": identity.workerId,
      "X-CP-Protocol": String(PROTOCOL_VERSION),
    };

    const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401) warnNotRegistered();
      const detail = await response.text().catch(() => "");
      throw new ApiError(
        `${method} ${path} failed: ${response.status} ${detail}`,
        response.status,
        detail
      );
    }
    return response;
  }

  function send(projectId: string, path: string, method: string, body?: unknown): Promise<Response> {
    return request(`/api/projects/${projectId}${path}`, method, body);
  }

  async function readColumns(projectId: string): Promise<BoardColumn[]> {
    const body = (await (await send(projectId, "", "GET")).json()) as { columns?: unknown };
    const columns = (Array.isArray(body.columns) ? body.columns : [])
      .map(toColumn)
      .filter((column): column is BoardColumn => column !== null)
      .sort((a, b) => a.order - b.order);
    return columns.length > 0 ? columns : SEEDED_BOARD;
  }

  const projectKeys = new Map<string, string>();
  let eventSeq = 0;

  async function keyForTasks(projectId: string): Promise<string> {
    const cached = projectKeys.get(projectId);
    if (cached) return cached;
    try {
      const body = (await (await send(projectId, "", "GET")).json()) as { key?: unknown };
      if (typeof body.key === "string" && body.key.trim()) {
        const key = body.key.trim();
        projectKeys.set(projectId, key);
        return key;
      }
    } catch {
    }
    return projectId;
  }

  return {
    async claim(projectId, runId) {
      let response: Response;
      try {
        response = await send(projectId, "/tasks/claim", "POST", { runId });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          throw new ClaimRefused(reasonIn(error.detail));
        }
        throw error;
      }
      if (response.status === 204) return null;

      const raw = (await response.json()) as RawTask;
      const taskKey = `${await keyForTasks(projectId)}-${raw.taskNumber}`;
      if (!isSafeTaskKey(taskKey)) {
        await send(projectId, `/tasks/${raw._id}/release`, "POST", { refund: false }).catch(
          () => {}
        );
        throw new Error(
          `refusing task key ${JSON.stringify(taskKey)}: expected a project key followed by a task number`
        );
      }

      const agent = parseAgent(raw.agent);
      if (!agent) {
        await send(projectId, `/tasks/${raw._id}/release`, "POST", { refund: false }).catch(
          () => {}
        );
        return null;
      }

      return {
        taskId: raw._id,
        agent,
        projectId: typeof raw.project === "string" && raw.project ? raw.project : projectId,
        taskKey,
        taskNumber: raw.taskNumber,
        title: raw.title,
        description: raw.description,
        acceptanceCriteria: (raw.checklist ?? [])
          .filter((item): item is { text: string } => typeof item.text === "string")
          .map((item) => item.text),
        attempts: raw.execution?.attempts ?? 0,
        runId:
          typeof raw.execution?.runId === "string" && raw.execution.runId
            ? raw.execution.runId
            : runId,
      };
    },

    async postRun(projectId, record) {
      await send(projectId, "/runs", "POST", {
        ...record,
        workerId: identityOrThrow().workerId,
      });
    },

    async setStatus(projectId, taskId, status) {
      await send(projectId, `/tasks/${taskId}/status`, "PATCH", { status });
    },

    async comment(projectId, taskId, body) {
      await send(projectId, `/tasks/${taskId}/comments`, "POST", { body });
    },

    async release(projectId, taskId, options) {
      await send(
        projectId,
        `/tasks/${taskId}/release`,
        "POST",
        options?.refund === false ? { refund: false } : undefined
      );
    },

    async columnIds(projectId) {
      return (await readColumns(projectId)).map((column) => column.id);
    },

    async statusIds(projectId) {
      return statusIdsFrom(await readColumns(projectId));
    },

    async postEvent(event) {
      const { workerId } = identityOrThrow();
      eventSeq += 1;
      const response = await request(
        `/api/workers/${workerId}/events`,
        "POST",
        { ...event, seq: eventSeq }
      );
      return { applied: await appliedFrom(response) };
    },
  };
}
