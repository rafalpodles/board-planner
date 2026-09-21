import type { MachineState } from "@/types";

export type { MachineState };

export type ReadinessGap = "no-repository" | "runs-off" | "no-machine" | "machine-stale";

export interface ReadinessFacts {
  repositoryUrl?: string | null;
  workerEnabled?: boolean | null;
  /** Unknown (`null`/omitted) is not judged: only the machine's own owner is ever told its state. */
  machine?: MachineState | null;
}

/**
 * What stops any agent run on a board, apart from the task itself. Derived from facts the board
 * already stores, so it goes away on its own once they are in place.
 */
export function readinessGaps(facts: ReadinessFacts): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  if (!facts.repositoryUrl?.trim()) gaps.push("no-repository");
  if (facts.workerEnabled !== true) gaps.push("runs-off");
  if (facts.machine === "none") gaps.push("no-machine");
  if (facts.machine === "stale") gaps.push("machine-stale");
  return gaps;
}
