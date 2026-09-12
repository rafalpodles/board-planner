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
  // Not the task's failure and not the agent's: this machine cannot run the step at all, and will
  // fail the next task identically. Separate from "error" because the two are accounted for
  // differently — see the released/machine-fault path in pipeline.ts.
  | { kind: "machine_fault"; message: string }
  | { kind: "error"; message: string };

export interface DiffStats {
  changedLines: number;
  changedFiles: string[];
  patch: string;
  truncated: boolean;
  /**
   * The symlinks the change adds or rewrites, with what they point at. `--numstat` renders a
   * symlink as one added line in a file of that name, indistinguishable from an ordinary one-line
   * file — measured — so a gate reading `changedFiles` alone cannot see that the change added a
   * door out of the checkout (BP-509).
   */
  symlinks: { path: string; target: string }[];
  /**
   * The changed files whose contents the patch does NOT carry, whatever the reason.
   *
   * Read off `--numstat`'s `-` for both counts, which is git saying "I am not going to show you
   * this one" — and that is the only signal that catches every way it happens. Measured on git
   * 2.50.1, three of them, none reached by `--no-ext-diff` or `--no-textconv`:
   *
   * - a bare `-diff` attribute, which needs no driver and no config at all;
   * - `diff=<name>` plus `[diff "<name>"] binary = true`, where the attribute reads as an ordinary
   *   driver name and only the config says what it does;
   * - a file git simply calls binary — a raw NUL inside a JavaScript block comment is enough, and
   *   nothing is planted anywhere.
   *
   * A genuinely binary asset lands here too, which is honest rather than a false positive: the
   * patch really does not show what changed in it.
   *
   * And one that `--numstat` does NOT catch, read from the file mode instead: a gitlink. Bumping a
   * submodule pointer measures `1  1` and prints two object ids, which is the whole of what a
   * reader is shown for a change that can carry anything at all — and it needs no `.gitmodules`
   * edit, so the protected path does not fire either.
   *
   * Whoever renders this patch as "the change" is rendering something with holes, and only they
   * can decide what that is worth (BP-381).
   */
  suppressedDiffs: string[];
  // The commit the diff was taken against, resolved once to an object id rather than left as the
  // ref `HEAD`. The review gate checks this out to read the change, so "what the reviewer saw" and
  // "what the gates judged" are the same commit by construction (BP-404).
  headSha: string;
}

export interface GateContext {
  worktreePath: string;
  /** See Worktree.configBaseline — what the config said before the agent ran (BP-346). */
  configBaseline?: readonly string[] | null;
  task: ClaimedTask;
  result: ExecutionResult;
  diff: DiffStats;
  signal?: AbortSignal;
}

export interface GateResult {
  ok: boolean;
  reason: string;
  /**
   * The gate did not judge the change — it could not run on this machine, and will not run for the
   * next task either. A refusal, reported as one, would blame the change for the machine and push
   * its branch; this routes it to the released path instead, with the attempt refunded.
   */
  machineFault?: boolean;
}

export interface Gate {
  name: string;
  run(context: GateContext): Promise<GateResult>;
}
