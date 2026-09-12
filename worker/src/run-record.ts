import { OutcomeKind } from "./telemetry.js";
import { ClaimedTask } from "./types.js";

// The worker's own vocabulary is about what it did; the board's is about what came of it. Only
// gateRejected differs, and it differs because "refused" is the word a report groups by.
const OUTCOMES: Record<OutcomeKind, string> = {
  delivered: "delivered",
  merged: "merged",
  gateRejected: "refused",
  blocked: "blocked",
  failed: "failed",
  requeued: "requeued",
  released: "released",
  machineFault: "machineFault",
};

/**
 * What the server stores. Cut here as well as there, because it cuts after reading the body: a
 * failed fetch puts the whole of git's stderr in the detail, and this record goes to the outbox,
 * which retries it. The number is the server's own (`runs/route.ts`), so nothing is lost that the
 * board would have kept.
 */
const MAX_DETAIL_CHARS = 2000;

export interface RunRecord {
  taskId: string;
  taskKey: string;
  agentId: string;
  agentName: string;
  outcome: string;
  refusedBy: string;
  detail: string;
  startedAt: string;
  finishedAt: string;
  costUsd: number;
}

/**
 * What a finished run leaves behind. Nothing did before: `execution.runId` lives on the task and
 * every exit clears it, so a run that ended was a run nobody could ask about afterwards.
 */
export function recordFor(
  task: ClaimedTask,
  kind: OutcomeKind,
  detail: string,
  startedAt: number,
  finishedAt: number,
  costUsd: number
): RunRecord {
  const refused = kind === "gateRejected";
  return {
    taskId: task.taskId,
    taskKey: task.taskKey,
    // By name as well as by id: an agent can be renamed or deleted, and what ran must not change
    // when it is.
    agentId: task.agent.agentId,
    agentName: task.agent.name,
    outcome: OUTCOMES[kind] ?? "failed",
    refusedBy: refused ? detail.slice(0, MAX_DETAIL_CHARS) : "",
    detail: refused ? "" : detail.slice(0, MAX_DETAIL_CHARS),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    costUsd,
  };
}
