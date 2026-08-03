export interface ClaimedTask {
  taskId: string;
  projectId: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  attempts: number;
  // The run recorded on the task itself, read back from the claim response. Every phase event is
  // authorized against it, so a locally invented value would simply be dropped by the server.
  runId: string;
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
