import { OutcomeKind } from "./telemetry.js";
import { ClaimedTask } from "./types.js";

const OUTCOMES: Record<OutcomeKind, string> = {
  delivered: "delivered",
  merged: "merged",
  gateRejected: "refused",
  blocked: "blocked",
  failed: "failed",
  requeued: "requeued",
  released: "released",
};

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
    agentId: task.agent.agentId,
    agentName: task.agent.name,
    outcome: OUTCOMES[kind] ?? "failed",
    refusedBy: refused ? detail : "",
    detail: refused ? "" : detail,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    costUsd,
  };
}
