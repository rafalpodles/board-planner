import { ApiClient, ApiError } from "./api.js";
import { RunRecord } from "./run-record.js";

// A report that cannot be delivered is worse than a failed run: the merge already happened, so
// the task sits in the active column where claimNextTask can never pick it up again. Merging to
// main also redeploys the app, which makes the report right after a merge the one most likely to
// fail — so it has to survive the process, not just the request.
export type OutboxOp =
  | { kind: "comment"; projectId: string; taskId: string; body: string }
  | { kind: "status"; projectId: string; taskId: string; status: string }
  | { kind: "release"; projectId: string; taskId: string; refund: boolean }
  // A record posted after a merge hits the same redeploy the comment does, and it is the only
  // trace the run leaves — losing it makes a finished run indistinguishable from one that never ran.
  | { kind: "run"; projectId: string; record: RunRecord };

interface Entry {
  op: OutboxOp;
  attempts: number;
}

export interface Store {
  read(): string;
  write(text: string): void;
}

export interface Outbox {
  add(op: OutboxOp): void;
  flush(api: ApiClient): Promise<{ delivered: number; pending: number; dropped: number }>;
  pending(): number;
}

const MAX_ATTEMPTS = 20;
const MAX_ENTRIES = 500;

/**
 * Whether the server's answer can be expected to differ next time.
 *
 * Named rather than a range, and the range was the first attempt: most 4xx answers say the request
 * was malformed, and the twenty-first attempt is then the first one identical to the first — while
 * every later report waits behind it, because order within a task matters and one failure stops
 * the drain (BP-613). A worker newer than its board is how that happens in practice: an outcome
 * the board's enum does not know answers `400 Unknown outcome`, once per poll.
 *
 * But "4xx" swept up three answers that are among the most transient the board gives, and dropping
 * one of those destroys the report this whole module exists to keep — the post-merge comment,
 * status or run record, without which a merged task sits in a column `claimNextTask` never looks at
 * (found in review):
 *
 * - **401** — the operator rotated or revoked this machine's credential. It comes back.
 * - **403** — a grant was being edited, or the worker was paused for a moment.
 * - **409** — `changeStatus` refuses a task another run holds (`task-service.ts`), which is exactly
 *   what an expired lease reclaiming a run looks like. The next flush is after that has settled.
 *
 * 408 and 429 are the two a server sends to mean "ask again" and were never in question. So the
 * list is what is left: a request the board will refuse in the same words for ever.
 *
 * **404 is not on it**, and that is the entry worth explaining. It is the one answer here a
 * *platform* can give rather than the board: merging to `main` redeploys the app, which is exactly
 * the moment this module's header says the report is most likely to fail, and a proxy answering
 * 404 in that window is not the board saying the task is gone. A deleted project really does
 * answer 404 for ever — and `MAX_ATTEMPTS` bounds that at twenty flushes, which is what it is for
 * (found in review). 405 stays: App Router answers it for a route file without that verb, which is
 * the "worker newer than its board" family this exists for. 413 earns its place — a `comment` op
 * carries patch output, and a body a platform limit rejects is rejected identically for ever.
 */
const PERMANENT_REFUSALS = new Set([400, 405, 410, 413, 414, 415, 422]);

function permanent(error: unknown): boolean {
  return error instanceof ApiError && PERMANENT_REFUSALS.has(error.status);
}

type Log = (message: string) => void;

function parse(text: string): Entry[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Entry;
        return entry?.op?.kind ? [entry] : [];
      } catch {
        return [];
      }
    });
}

function serialise(entries: Entry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function taskOf(op: OutboxOp): string {
  return op.kind === "run" ? op.record.taskId : op.taskId;
}

async function deliver(api: ApiClient, op: OutboxOp): Promise<void> {
  if (op.kind === "comment") return api.comment(op.projectId, op.taskId, op.body);
  if (op.kind === "status") return api.setStatus(op.projectId, op.taskId, op.status);
  if (op.kind === "run") return api.postRun(op.projectId, op.record);
  return op.refund
    ? api.release(op.projectId, op.taskId)
    : api.release(op.projectId, op.taskId, { refund: false });
}

export function createOutbox(store: Store, log: Log = (m) => console.error(m)): Outbox {
  function load(): Entry[] {
    try {
      return parse(store.read());
    } catch {
      return [];
    }
  }

  function save(entries: Entry[]): void {
    try {
      store.write(serialise(entries));
    } catch (error) {
      log(`outbox: could not persist ${entries.length} undelivered report(s): ${String(error)}`);
    }
  }

  return {
    add(op) {
      const entries = load();
      entries.push({ op, attempts: 0 });
      // Oldest first: a report about a task from an hour ago matters less than the current one
      save(entries.slice(-MAX_ENTRIES));
    },

    pending() {
      return load().length;
    },

    async flush(api) {
      const entries = load();
      if (entries.length === 0) return { delivered: 0, pending: 0, dropped: 0 };

      const remaining: Entry[] = [];
      let delivered = 0;
      let dropped = 0;
      let blocked = false;

      for (const entry of entries) {
        // Order matters within a task — a status move before its comment reads as an empty
        // decision — so one failure stops the drain rather than reordering around it
        if (blocked) {
          remaining.push(entry);
          continue;
        }
        try {
          await deliver(api, entry.op);
          delivered += 1;
        } catch (error) {
          if (permanent(error)) {
            dropped += 1;
            log(
              `outbox: dropping ${entry.op.kind} for task ${taskOf(entry.op)} — the board refused it and will refuse it again: ${String(error)}`
            );
            continue;
          }
          const attempts = entry.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            dropped += 1;
            log(
              `outbox: giving up on ${entry.op.kind} for task ${taskOf(entry.op)} after ${attempts} attempts: ${String(error)}`
            );
            continue;
          }
          remaining.push({ ...entry, attempts });
          blocked = true;
        }
      }

      save(remaining);
      return { delivered, pending: remaining.length, dropped };
    },
  };
}
