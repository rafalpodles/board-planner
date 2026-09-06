import { AgentRunOutcome } from "@/types";

const OUTCOME_LABELS: Record<AgentRunOutcome, string> = {
  delivered: "Pull request open",
  merged: "Merged",
  refused: "Refused",
  blocked: "Went to a human",
  failed: "Failed",
  requeued: "Back in the queue",
  released: "Released",
};

const FAILED_OUTCOMES = new Set<AgentRunOutcome>(["refused", "blocked", "failed"]);

interface Ended {
  outcome: AgentRunOutcome;
  refusedBy: string;
}

export function endState(run: Ended): string {
  return run.refusedBy ? `Refused: ${run.refusedBy}` : OUTCOME_LABELS[run.outcome];
}

export function endedBadly(run: Ended): boolean {
  return FAILED_OUTCOMES.has(run.outcome);
}
