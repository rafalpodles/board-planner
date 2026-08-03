import { ApiClient } from "./api.js";

// A report that cannot be delivered is worse than a failed run: the merge already happened, so
// the task sits in the active column where claimNextTask can never pick it up again. Merging to
// main also redeploys the app, which makes the report right after a merge the one most likely to
// fail — so it has to survive the process, not just the request.
export type OutboxOp =
  | { kind: "comment"; projectId: string; taskId: string; body: string }
  | { kind: "status"; projectId: string; taskId: string; status: string }
  | { kind: "release"; projectId: string; taskId: string; refund: boolean };

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

async function deliver(api: ApiClient, op: OutboxOp): Promise<void> {
  if (op.kind === "comment") return api.comment(op.projectId, op.taskId, op.body);
  if (op.kind === "status") return api.setStatus(op.projectId, op.taskId, op.status);
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
          const attempts = entry.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            dropped += 1;
            log(
              `outbox: giving up on ${entry.op.kind} for task ${entry.op.taskId} after ${attempts} attempts: ${String(error)}`
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
