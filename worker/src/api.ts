import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { WorkerConfig } from "./config.js";
import { loadIdentity, PROTOCOL_VERSION, Store } from "./registration.js";
import { ClaimedTask } from "./types.js";

type Fetch = typeof globalThis.fetch;
type Credential = "api" | "worker";

const NOT_REGISTERED_MESSAGE = "this worker is not registered — see worker/README.md";

export interface StatusIds {
  approved: string;
  review: string;
  done: string;
}

export interface ApiClient {
  claim(runId: string): Promise<ClaimedTask | null>;
  setStatus(taskId: string, status: string): Promise<void>;
  comment(taskId: string, body: string): Promise<void>;
  release(taskId: string, options?: { refund?: boolean }): Promise<void>;
  statusIds(): Promise<StatusIds>;
  columnIds(): Promise<string[]>;
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

// The board the server itself falls back to for a project stored with no columns of its own
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

const SEEDED = statusIdsFrom(SEEDED_BOARD);

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

// The claim credential lives at <stateDir>/worker.json, written by registration.ts. Read fresh on
// every worker-credentialed call rather than cached at construction time, so a credential that
// registration.ts refreshes (first registration, or re-registration after a 401) takes effect on
// the very next call without restarting the process.
//
// Same mode discipline as config.ts's readSecretFile and repos.ts's createAllowlistReader: a copy
// readable by group or others is refused, not silently trusted. writeFileSync's mode option only
// applies at file creation, so an existing loose file would otherwise stay loose forever.
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
  config: WorkerConfig,
  fetchImpl: Fetch = fetch,
  identitySource?: Pick<Store, "read">
): ApiClient {
  const base = `${config.apiBaseUrl}/api/projects/${config.projectId}`;
  let warnedNotRegistered = false;

  function warnNotRegistered(): void {
    if (warnedNotRegistered) return;
    warnedNotRegistered = true;
    console.error(NOT_REGISTERED_MESSAGE);
  }

  async function send(path: string, method: string, body?: unknown, credential: Credential = "api"): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (credential === "worker") {
      const identity = loadIdentity(identitySource ?? fileIdentityReader(config.stateDir));
      if (!identity) {
        warnNotRegistered();
        throw new Error(NOT_REGISTERED_MESSAGE);
      }
      headers.Authorization = `Bearer ${identity.credential}`;
      headers["X-Worker-Id"] = identity.workerId;
      headers["X-CP-Protocol"] = String(PROTOCOL_VERSION);
    } else {
      headers.Authorization = `Bearer ${config.apiToken}`;
    }

    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (credential === "worker" && response.status === 401) warnNotRegistered();
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${path} failed: ${response.status} ${detail}`);
    }
    return response;
  }

  async function readColumns(): Promise<BoardColumn[]> {
    const body = (await (await send("", "GET")).json()) as { columns?: unknown };
    const columns = (Array.isArray(body.columns) ? body.columns : [])
      .map(toColumn)
      .filter((column): column is BoardColumn => column !== null)
      .sort((a, b) => a.order - b.order);
    return columns.length > 0 ? columns : SEEDED_BOARD;
  }

  let projectKey = "";

  // CP_PROJECT_ID addresses the project, and the route accepts an ObjectId as readily as a key —
  // so the key a task is named by has to come from the project itself, not from that setting
  async function keyForTasks(): Promise<string> {
    if (projectKey) return projectKey;
    try {
      const body = (await (await send("", "GET")).json()) as { key?: unknown };
      if (typeof body.key === "string" && body.key.trim()) projectKey = body.key.trim();
    } catch {
      // The task is claimed by the time this runs; the configured id keeps it moving
    }
    return projectKey || config.projectId;
  }

  return {
    async claim(runId) {
      const response = await send("/tasks/claim", "POST", { runId }, "worker");
      if (response.status === 204) return null;

      const raw = (await response.json()) as RawTask;
      return {
        taskId: raw._id,
        taskKey: `${await keyForTasks()}-${raw.taskNumber}`,
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

    async release(taskId, options) {
      await send(
        `/tasks/${taskId}/release`,
        "POST",
        options?.refund === false ? { refund: false } : undefined
      );
    },

    async columnIds() {
      return (await readColumns()).map((column) => column.id);
    },

    async statusIds() {
      const ids = statusIdsFrom(await readColumns());
      return {
        approved: ids.approved || SEEDED.approved,
        review: ids.review || SEEDED.review,
        done: ids.done || SEEDED.done,
      };
    },
  };
}
