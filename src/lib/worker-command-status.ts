export type WorkerCommand = "pause" | "resume" | "stop";

export interface CommandStatus {
  text: string;
  tone: "pending" | "applied" | "warning";
}

interface CommandStateWorker {
  command: "" | WorkerCommand;
  commandIssuedAt: string | null;
  commandAckedAt: string | null;
}

const UNACKED_WARNING_MS = 60_000;

const COMMAND_LABELS: Record<WorkerCommand, { pending: string; applied: string }> = {
  pause: { pending: "Pausing…", applied: "Paused" },
  resume: { pending: "Resuming…", applied: "Resumed" },
  stop: { pending: "Stopping…", applied: "Stopped" },
};

// The worker only proves a command took effect by acking it over heartbeat, so this
// must never report "applied" from commandIssuedAt alone — that would claim a worker
// is paused while it could still be mid-merge. "Newer than", not "at least as new
// as": an ack timestamped exactly at the issue timestamp has not yet proven anything.
export function commandStatus(worker: CommandStateWorker, now: number = Date.now()): CommandStatus | null {
  if (!worker.command) return null;
  const issuedAt = worker.commandIssuedAt ? new Date(worker.commandIssuedAt).getTime() : null;
  const ackedAt = worker.commandAckedAt ? new Date(worker.commandAckedAt).getTime() : null;

  if (ackedAt !== null && (issuedAt === null || ackedAt > issuedAt)) {
    return { text: COMMAND_LABELS[worker.command].applied, tone: "applied" };
  }

  const elapsedMs = issuedAt !== null ? now - issuedAt : 0;
  if (elapsedMs >= UNACKED_WARNING_MS) {
    return { text: `not acknowledged for ${Math.floor(elapsedMs / 1000)}s`, tone: "warning" };
  }
  return { text: COMMAND_LABELS[worker.command].pending, tone: "pending" };
}
