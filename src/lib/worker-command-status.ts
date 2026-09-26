import type { ApiWorkerHalt } from "@/types";

export type WorkerCommand = "pause" | "resume" | "stop";

export interface CommandStatus {
  text: string;
  tone: "pending" | "applied" | "warning";
}

interface CommandStateWorker {
  command: "" | WorkerCommand;
  commandIssuedAt: string | null;
  commandAckedAt: string | null;
  halt?: ApiWorkerHalt | null;
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
  const issuedAt = worker.commandIssuedAt ? new Date(worker.commandIssuedAt).getTime() : null;
  const ackedAt = worker.commandAckedAt ? new Date(worker.commandAckedAt).getTime() : null;
  const applied = ackedAt !== null && (issuedAt === null || ackedAt > issuedAt);

  if (worker.command && !applied) {
    const elapsedMs = issuedAt !== null ? now - issuedAt : 0;
    if (elapsedMs >= UNACKED_WARNING_MS) {
      return { text: `not acknowledged for ${Math.floor(elapsedMs / 1000)}s`, tone: "warning" };
    }
    return { text: COMMAND_LABELS[worker.command].pending, tone: "pending" };
  }

  // What the machine says outranks the last command it acknowledged: a pause or resume made at the
  // machine itself never passes through the board
  if (worker.halt?.paused && worker.halt.by === "machine") {
    return {
      text: worker.halt.command === "stop" ? "Stopped on the machine" : "Paused on the machine",
      tone: "applied",
    };
  }
  if (!worker.command) return null;
  if (worker.halt && !worker.halt.paused && worker.command !== "resume") {
    return { text: "Resumed on the machine", tone: "applied" };
  }
  return { text: COMMAND_LABELS[worker.command].applied, tone: "applied" };
}
