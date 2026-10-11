import type { ApiBoardReadyStep, BoardReadyStepId, MachineState } from "@/types";

export interface BoardReadyFacts {
  hasTasks: boolean;
  /** People with a grant on the board, the owner included */
  grantCount: number;
  repositoryUrl: string;
  workerEnabled: boolean;
  lockedByInstance: boolean;
  machine: MachineState;
  readerIsInstanceAdmin: boolean;
}

export const BOARD_READY_STEPS: readonly { id: BoardReadyStepId; group: ApiBoardReadyStep["group"] }[] = [
  { id: "board", group: "setup" },
  { id: "tasks", group: "setup" },
  { id: "team", group: "setup" },
  { id: "repository", group: "agents" },
  { id: "runs", group: "agents" },
  { id: "machine", group: "agents" },
];

export function boardReadySteps(facts: BoardReadyFacts): ApiBoardReadyStep[] {
  const done: Record<BoardReadyStepId, boolean> = {
    board: true,
    tasks: facts.hasTasks,
    team: facts.grantCount > 1,
    repository: facts.repositoryUrl.trim() !== "",
    runs: facts.workerEnabled && !facts.lockedByInstance,
    machine: facts.machine === "live",
  };
  return BOARD_READY_STEPS.map(({ id, group }) => ({
    id,
    group,
    done: done[id],
    locked: id === "runs" && facts.lockedByInstance && !facts.readerIsInstanceAdmin,
  }));
}

export function boardReadyComplete(steps: ApiBoardReadyStep[]): boolean {
  return steps.every((s) => s.done);
}

export const MAX_DISMISSED_BOARD_READY = 200;
