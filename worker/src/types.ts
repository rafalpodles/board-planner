export interface SnapshotEntry {
  key: string;
  kind: "step" | "gate";
  name: string;
  prompt?: string;
  capability?: "read-only" | "edit";
  model?: string;
  fallbackModel?: string;
  deterministic?: boolean;
  gateKind?: string;
  params?: Record<string, string>;
}

export interface AgentSnapshot {
  agentId: string;
  name: string;
  sequence: SnapshotEntry[];
}

export interface ClaimedTask {
  taskId: string;
  projectId: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  attempts: number;
  agent: AgentSnapshot;
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
  symlinks: { path: string; target: string }[];
  headSha: string;
}

export interface GateContext {
  worktreePath: string;
  configBaseline?: readonly string[] | null;
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
