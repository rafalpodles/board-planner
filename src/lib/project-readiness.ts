import { ROLES_A_RUN_NEEDS } from "@/lib/claim-refusal";
import { ROLE_LABELS, type ColumnRole, type MachineState } from "@/types";
import { isWorkerLockedByInstance, projectRunsWorkers } from "@/lib/worker-gate";

export type { MachineState };

export type ReadinessGap =
  | "no-repository"
  | "runs-off"
  | "runs-locked"
  | "missing-columns"
  | "no-machine"
  | "machine-stale"
  | "machine-paused"
  | "machine-stopped"
  | "machine-failing";

export interface ReadinessFacts {
  repositoryUrl?: string | null;
  workerEnabled?: boolean | null;
  /** An instance admin's lock, which wins over `workerEnabled` (see projectRunsWorkers) */
  lockedByInstance?: boolean | null;
  /** Omitted, the board's columns are not judged */
  columns?: RoleBearing[];
  /** Unknown (`null`/omitted) is not judged: only the machine's own owner is ever told its state. */
  machine?: MachineState | null;
}

type RoleBearing = { role: ColumnRole };

export function missingRunRoles(columns: RoleBearing[]): ColumnRole[] {
  return ROLES_A_RUN_NEEDS.filter((role) => !columns.some((c) => c.role === role));
}

/** "A", "A or B", "A, B or C" */
export function orList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** The roles a run needs that this board lacks, as their labels: "Awaiting review or Done" */
export function missingRolesText(columns: RoleBearing[]): string {
  return orList(missingRunRoles(columns).map((role) => ROLE_LABELS[role].label));
}

const MACHINE_GAPS: Partial<Record<MachineState, ReadinessGap>> = {
  none: "no-machine",
  stale: "machine-stale",
  paused: "machine-paused",
  stopped: "machine-stopped",
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
  const enabled = facts.workerEnabled === true;
  const worker = { enabled, lockedByInstance: facts.lockedByInstance === true };
  if (!projectRunsWorkers(worker)) {
    // Both when both, the lock first: switching runs on changes nothing while the lock stands
    if (isWorkerLockedByInstance(worker)) gaps.push("runs-locked");
    if (!enabled) gaps.push("runs-off");
  }
  if (facts.columns && missingRunRoles(facts.columns).length > 0) gaps.push("missing-columns");
  // With no repository no machine can serve the board, and "connect a machine" would be advice
  // that cannot work until the repository is named
  const machineGap = facts.machine ? MACHINE_GAPS[facts.machine] : undefined;
  if (machineGap && !noRepository) gaps.push(machineGap);
  return gaps;
}
