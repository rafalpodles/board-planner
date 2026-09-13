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
  machineFault: "Machine fault",
};

// `machineFault` is here and `released` is not, and that difference is the point of recording the
// two apart: a release is the account waiting for a clock and repairs itself, a fault is a machine
// somebody has to go and look at (BP-609).
const FAILED_OUTCOMES = new Set<AgentRunOutcome>(["refused", "blocked", "failed", "machineFault"]);

interface Ended {
  outcome: AgentRunOutcome;
  refusedBy: string;
}

/**
 * Who is reading, which changes exactly one label.
 *
 * The fleet's run history has a Machine column and fills it; a project's recent runs has neither
 * the column nor the name behind it — `toApiRun` does not carry the worker, and adding it would
 * put every machine's name in front of every project member to answer a question none of them can
 * act on: an instance admin gets the column, and the machine's owner is notified locally (BP-614).
 *
 * So the project's view says what happened to the task rather than what happened to a machine it
 * cannot name. "Didn't run" and the neighbouring "Back in the queue" are different words for
 * different outcomes, which is the distinction BP-609 recorded them apart for.
 */
export type RunAudience = "fleet" | "project";

const PROJECT_LABELS: Partial<Record<AgentRunOutcome, string>> = {
  machineFault: "Didn't run",
};

/** Which gate refused is the difference between raising a limit and rewriting the change. */
export function endState(run: Ended, audience: RunAudience = "fleet"): string {
  if (run.refusedBy) return `Refused: ${run.refusedBy}`;
  const forAudience = audience === "project" ? PROJECT_LABELS[run.outcome] : undefined;
  return forAudience ?? OUTCOME_LABELS[run.outcome];
}

export function endedBadly(run: Ended): boolean {
  return FAILED_OUTCOMES.has(run.outcome);
}
