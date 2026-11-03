import { PullRequestState } from "./delivery.js";
import { Outbox, Store } from "./outbox.js";
import { scrub } from "./scrub.js";

/**
 * A pull request this machine left with GitHub's auto-merge armed, and the task it reported into
 * review. The run is over by then, so nothing else on the board will ever move that task: the
 * GitHub sync never moves one, because a move needs an author (BP-1128).
 */
export interface QueuedMerge {
  projectId: string;
  taskId: string;
  taskKey: string;
  prUrls: string[];
  /** The review column the run reported into: the task is moved only from there. */
  review: string;
  done: string;
  queuedAt: string;
  checkedAt?: string;
}

export interface QueuedMerges {
  add(entry: QueuedMerge): void;
  list(): QueuedMerge[];
  replace(entries: QueuedMerge[]): void;
}

export const CHECK_INTERVAL_MS = 2 * 60_000;
export const WATCH_LIMIT_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 200;

type Log = (message: string) => void;

function isQueuedMerge(value: unknown): value is QueuedMerge {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    ["projectId", "taskId", "taskKey", "review", "done", "queuedAt"].every((key) => typeof entry[key] === "string") &&
    Array.isArray(entry.prUrls) &&
    entry.prUrls.length > 0 &&
    entry.prUrls.every((url) => typeof url === "string")
  );
}

export function createQueuedMerges(store: Store, log: Log = (m) => console.error(m)): QueuedMerges {
  function list(): QueuedMerge[] {
    try {
      const parsed: unknown = JSON.parse(store.read() || "[]");
      return Array.isArray(parsed) ? parsed.filter(isQueuedMerge) : [];
    } catch {
      return [];
    }
  }

  function replace(entries: QueuedMerge[]): void {
    try {
      store.write(JSON.stringify(entries.slice(-MAX_ENTRIES)));
    } catch (error) {
      log(`could not persist ${entries.length} queued merge(s): ${String(error)}`);
    }
  }

  return {
    add(entry) {
      replace([...list().filter((each) => each.taskId !== entry.taskId), entry]);
    },
    list,
    replace,
  };
}

export interface WatchDeps {
  merges: QueuedMerges;
  pullRequestState: (prUrl: string) => Promise<PullRequestState>;
  outbox: Pick<Outbox, "add">;
  now: () => number;
  log?: Log;
}

/**
 * Asks GitHub about each queued pull request at most every `CHECK_INTERVAL_MS`. Merged: the task goes
 * to done, but only from the review column the run left it in, so a person who has moved it since
 * keeps it where they put it. Closed unmerged: a comment, and the task stays in review. The reports
 * go through the outbox, so a redeploy of the board does not lose them.
 */
export async function watchQueuedMerges(deps: WatchDeps): Promise<void> {
  const entries = deps.merges.list();
  if (entries.length === 0) return;
  const now = deps.now();
  const kept: QueuedMerge[] = [];

  for (const entry of entries) {
    if (entry.checkedAt && now - Date.parse(entry.checkedAt) < CHECK_INTERVAL_MS) {
      kept.push(entry);
      continue;
    }
    const states: PullRequestState[] = [];
    for (const url of entry.prUrls) states.push(await deps.pullRequestState(url).catch((): PullRequestState => "unknown"));
    const urls = entry.prUrls.map(scrub).join(", ");
    const { projectId, taskId } = entry;

    const closed = entry.prUrls.filter((_, index) => states[index] === "closed").map(scrub);
    if (closed.length > 0) {
      deps.outbox.add({
        kind: "comment",
        projectId,
        taskId,
        body: `${closed.join(", ")} ${closed.length > 1 ? "were" : "was"} closed without being merged, so the task stays here.`,
      });
      continue;
    }
    if (states.every((state) => state === "merged")) {
      deps.outbox.add({ kind: "comment", projectId, taskId, body: `GitHub merged ${urls}.` });
      deps.outbox.add({ kind: "status", projectId, taskId, status: entry.done, from: entry.review });
      continue;
    }
    if (now - Date.parse(entry.queuedAt) > WATCH_LIMIT_MS) {
      deps.outbox.add({
        kind: "comment",
        projectId,
        taskId,
        body: `${urls} is still not merged after 30 days, so this worker stopped watching it. The task stays here.`,
      });
      continue;
    }
    kept.push({ ...entry, checkedAt: new Date(now).toISOString() });
  }

  deps.merges.replace(kept);
}
