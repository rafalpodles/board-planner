import { AgentRunOutcome } from "@/types";

// One definition for every view that reads a finished run: the project's recent runs and the
// fleet's run history.
const OUTCOME_LABELS: Record<AgentRunOutcome, string> = {
  delivered: "Pull request open",
  merged: "Merged",
  refused: "Refused",
  blocked: "Went to a human",
  failed: "Failed",
  requeued: "Back in the queue",
  released: "Released",
  faulted: "Machine fault",
};

// `faulted` is here and `released` is not, and that difference is the point of recording the two
// apart: a release is the account waiting for a clock and repairs itself, a fault is a machine an
// operator has to go and fix, and it is taking no work until they do (BP-609).
const FAILED_OUTCOMES = new Set<AgentRunOutcome>(["refused", "blocked", "failed", "faulted"]);

interface Ended {
  outcome: AgentRunOutcome;
  refusedBy: string;
}

/** Which gate refused is the difference between raising a limit and rewriting the change. */
export function endState(run: Ended): string {
  return run.refusedBy ? `Refused: ${run.refusedBy}` : OUTCOME_LABELS[run.outcome];
}

export function endedBadly(run: Ended): boolean {
  return FAILED_OUTCOMES.has(run.outcome);
}
