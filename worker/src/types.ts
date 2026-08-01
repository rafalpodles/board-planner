export interface ClaimedTask {
  taskId: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  attempts: number;
}

export interface ExecutionResult {
  status: "completed" | "blocked";
  summary: string;
  filesChanged: string[];
  testsAdded: string[];
  blockedReason: string;
}

export type RunOutcome =
  | { kind: "result"; result: ExecutionResult }
  | { kind: "usage_limit" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export interface DiffStats {
  changedLines: number;
  changedFiles: string[];
  patch: string;
  truncated: boolean;
}

export interface GateContext {
  worktreePath: string;
  task: ClaimedTask;
  result: ExecutionResult;
  diff: DiffStats;
  signal?: AbortSignal;
}

export interface GateResult {
  ok: boolean;
  reason: string;
}

export interface Gate {
  name: string;
  run(context: GateContext): Promise<GateResult>;
}
