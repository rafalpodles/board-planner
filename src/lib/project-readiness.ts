import type { AnyColumn } from "@/lib/columns";
import { ROLES_A_RUN_NEEDS } from "@/lib/claim-refusal";
import type { ColumnRole, MachineState } from "@/types";

export type { MachineState };

export type ReadinessGap =
  | "no-repository"
  | "runs-off"
  | "missing-columns"
  | "no-machine"
  | "machine-stale"
  | "machine-paused"
  | "machine-failing";

export interface ReadinessFacts {
  repositoryUrl?: string | null;
  workerEnabled?: boolean | null;
  /** Omitted, the board's columns are not judged */
  columns?: AnyColumn[];
  /** Unknown (`null`/omitted) is not judged: only the machine's own owner is ever told its state. */
  machine?: MachineState | null;
}

export function missingRunRoles(columns: AnyColumn[]): ColumnRole[] {
  return ROLES_A_RUN_NEEDS.filter((role) => !columns.some((c) => c.role === role));
}

const MACHINE_GAPS: Partial<Record<MachineState, ReadinessGap>> = {
  none: "no-machine",
  stale: "machine-stale",
  paused: "machine-paused",
  failing: "machine-failing",
};

/**
 * What stops any agent run on a board, apart from the task itself. Derived from facts the board
 * already stores, so it goes away on its own once they are in place.
 */
export function readinessGaps(facts: ReadinessFacts): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  const noRepository = !facts.repositoryUrl?.trim();
  if (noRepository) gaps.push("no-repository");
  if (facts.workerEnabled !== true) gaps.push("runs-off");
  if (facts.columns && missingRunRoles(facts.columns).length > 0) gaps.push("missing-columns");
  // With no repository no machine can serve the board, and "connect a machine" would be advice
  // that cannot work until the repository is named
  const machineGap = facts.machine ? MACHINE_GAPS[facts.machine] : undefined;
  if (machineGap && !noRepository) gaps.push(machineGap);
  return gaps;
}
