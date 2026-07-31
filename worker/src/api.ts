import { WorkerConfig } from "./config.js";
import { ClaimedTask } from "./types.js";

type Fetch = typeof globalThis.fetch;

export interface ApiClient {
  claim(runId: string): Promise<ClaimedTask | null>;
  setStatus(taskId: string, status: string): Promise<void>;
  comment(taskId: string, body: string): Promise<void>;
}

interface RawTask {
  _id: string;
  taskNumber: number;
  title: string;
  description: string;
  checklist?: Array<{ text: string }>;
  execution?: { attempts?: number };
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
        acceptanceCriteria: (raw.checklist ?? []).map((item) => item.text),
        attempts: raw.execution?.attempts ?? 0,
      };
    },

    async setStatus(taskId, status) {
      await send(`/tasks/${taskId}/status`, "PATCH", { status });
    },

    async comment(taskId, body) {
      await send(`/tasks/${taskId}/comments`, "POST", { body });
    },
  };
}
