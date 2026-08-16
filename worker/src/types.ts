/**
 * One position in the agent the claim resolved. The prompt and the parameter values travel; a tool
 * list never does — `capability` is a name this side maps to a list of its own, so a server cannot
 * widen what a step may do.
 */
export interface SnapshotEntry {
  key: string;
  kind: "step" | "gate";
  name: string;
  /** step only */
  prompt?: string;
  capability?: "read-only" | "edit";
  model?: string;
  fallbackModel?: string;
  deterministic?: boolean;
  /** gate only */
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
  // Resolved by the server at claim time and sent whole, not by reference: the agent can be edited
  // or deleted while this run holds the task, and a run has to mean what it meant when it started.
  agent: AgentSnapshot;
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
