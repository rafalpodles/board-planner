import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { Bootstrap } from "./config.js";
import { Identity, loadIdentity, PROTOCOL_VERSION, Store } from "./registration.js";
import { ClaimedTask } from "./types.js";

type Fetch = typeof globalThis.fetch;

const NOT_REGISTERED_MESSAGE = "this worker is not registered — see worker/README.md";

export interface StatusIds {
  approved: string;
  review: string;
  done: string;
}

// What the run is doing, addressed by the task and the run that holds it. `seq` is not here: the
// client stamps it as the call is made, so ordering follows the order events were reported rather
// than the order the network happened to deliver them in.
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
  // `applied` is the server's answer to "did this land": false when it wrote nothing, because the
  // run no longer holds the task or a newer event got there first
  postEvent(event: PhaseEvent): Promise<{ applied: boolean }>;
}

// A task key is server-controlled text that the worker turns into a directory name under its own
// worktree root and into a positional git argument. Refused here rather than sanitised: a key this
// worker cannot name safely is one it must not run under some other name nobody chose.
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

// Only an explicit `false` is a refusal. The caller ends the run on one, so a body that will not
// parse — a proxy's error page, a server that predates the field — must not read as one.
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

// A worker may hold assignments to several projects, so the base URL is no longer fixed at
// construction — it is built per call from the project the call concerns. One client is built
// once, from Bootstrap alone, before any assignment or repository is known.
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

  // Path from the api root, so a call can address /api/workers/... as readily as a project
  // One credential for everything. A second, project-scoped API token cannot work here: a worker's
  // grant is recomputed every heartbeat from the checkouts it reports crossed with every enabled
  // project, while a minted token carries a list fixed at mint time. Enable a second project and
  // the claim would travel on the worker credential while the report 403s on the API one, leaving
  // the task in the active column until its lease expired — silently, to every project added.
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
      throw new Error(`${method} ${path} failed: ${response.status} ${detail}`);
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

  // The assignment addresses a project by its ObjectId, and the route accepts a key as readily
  // as an id — so the key a task is named by has to come from the project itself
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
      // The task is claimed by the time this runs; the id used to claim it keeps it moving
    }
    return projectId;
  }

  return {
    async claim(projectId, runId) {
      const response = await send(projectId, "/tasks/claim", "POST", { runId });
      if (response.status === 204) return null;

      const raw = (await response.json()) as RawTask;
      const taskKey = `${await keyForTasks(projectId)}-${raw.taskNumber}`;
      if (!isSafeTaskKey(taskKey)) {
        // Handed back with the attempt charged, not refunded: no later attempt can name this key
        // either, so charging is what eventually parks the task for a human instead of claiming
        // and refusing it again on every poll.
        await send(projectId, `/tasks/${raw._id}/release`, "POST", { refund: false }).catch(
          () => {}
        );
        throw new Error(
          `refusing task key ${JSON.stringify(taskKey)}: expected a project key followed by a task number`
        );
      }

      return {
        taskId: raw._id,
        projectId: typeof raw.project === "string" && raw.project ? raw.project : projectId,
        taskKey,
        taskNumber: raw.taskNumber,
        title: raw.title,
        description: raw.description,
        acceptanceCriteria: (raw.checklist ?? [])
          .filter((item): item is { text: string } => typeof item.text === "string")
          .map((item) => item.text),
        attempts: raw.execution?.attempts ?? 0,
        // The run stored on the task wins over the one this call proposed: the server is what
        // every later event is checked against
        runId:
          typeof raw.execution?.runId === "string" && raw.execution.runId
            ? raw.execution.runId
            : runId,
      };
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
      const ids = statusIdsFrom(await readColumns(projectId));
      return {
        approved: ids.approved || SEEDED.approved,
        review: ids.review || SEEDED.review,
        done: ids.done || SEEDED.done,
      };
    },

    // The worker id in the path comes from the same identity that signs the request, so the two
    // cannot disagree — the server 403s a path that names anyone else
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
