import { WorkerConfig } from "./config.js";
import { ClaimedTask } from "./types.js";

type Fetch = typeof globalThis.fetch;

export interface StatusIds {
  approved: string;
  review: string;
  done: string;
}

export interface ApiClient {
  claim(runId: string): Promise<ClaimedTask | null>;
  setStatus(taskId: string, status: string): Promise<void>;
  comment(taskId: string, body: string): Promise<void>;
  release(taskId: string): Promise<void>;
  statusIds(): Promise<StatusIds>;
}

interface RawTask {
  _id: string;
  taskNumber: number;
  title: string;
  description: string;
  checklist?: Array<{ text?: unknown }>;
  execution?: { attempts?: number };
}

interface BoardColumn {
  id: string;
  role: string;
  order: number;
  triggersPmReview: boolean;
}

// The ids the server itself falls back to for a board with no columns
const SEEDED: StatusIds = { approved: "todo", review: "needs_human_review", done: "done" };

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

export function createApiClient(config: WorkerConfig, fetchImpl: Fetch = fetch): ApiClient {
  const base = `${config.apiBaseUrl}/api/projects/${config.projectId}`;

  async function send(path: string, method: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${path} failed: ${response.status} ${detail}`);
    }
    return response;
  }

  return {
    async claim(runId) {
      const response = await send("/tasks/claim", "POST", {
        workerId: config.workerId,
        runId,
      });
      if (response.status === 204) return null;

      const raw = (await response.json()) as RawTask;
      return {
        taskId: raw._id,
        taskKey: `${config.projectId}-${raw.taskNumber}`,
        taskNumber: raw.taskNumber,
        title: raw.title,
        description: raw.description,
        acceptanceCriteria: (raw.checklist ?? [])
          .filter((item): item is { text: string } => typeof item.text === "string")
          .map((item) => item.text),
        attempts: raw.execution?.attempts ?? 0,
      };
    },

    async setStatus(taskId, status) {
      await send(`/tasks/${taskId}/status`, "PATCH", { status });
    },

    async comment(taskId, body) {
      await send(`/tasks/${taskId}/comments`, "POST", { body });
    },

    async release(taskId) {
      await send(`/tasks/${taskId}/release`, "POST");
    },

    async statusIds() {
      const response = await send("", "GET");
      const body = (await response.json()) as { columns?: unknown };
      const columns = (Array.isArray(body.columns) ? body.columns : [])
        .map(toColumn)
        .filter((column): column is BoardColumn => column !== null)
        .sort((a, b) => a.order - b.order);

      const withRole = (role: string) => columns.filter((column) => column.role === role);
      const review = withRole("review");

      return {
        approved: withRole("approved")[0]?.id ?? SEEDED.approved,
        review: (review.find((column) => column.triggersPmReview) ?? review[0])?.id ?? SEEDED.review,
        done: withRole("done")[0]?.id ?? SEEDED.done,
      };
    },
  };
}
