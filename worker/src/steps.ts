import { TamperedCheckoutError } from "./commit.js";
import { Delivery } from "./delivery.js";
import { Executor } from "./executor.js";
import { Runner } from "./exec.js";
import { unexpectedHistory } from "./provenance.js";
import { StreamEvent } from "./stream.js";
import { ClaimedTask, ExecutionResult, SnapshotEntry } from "./types.js";

export type StepOutcome =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "usage_limit" }
  | { kind: "timeout" }
  | { kind: "machine_fault"; message: string }
  // The checkout carries a key git would run, found by the scan in front of the staging. Its own
  // kind rather than an `error` carrying a sentence, because the pipeline owes it a different
  // answer: a person has to look at the tree, so the run is parked and the worktree is kept, where
  // an `error` from a model step is requeued and the tree destroyed (BP-506).
  | { kind: "tampered"; finding: string; message: string }
  | { kind: "error"; message: string };

export interface RunState {
  /** Whether any step has committed yet — an exit after one must not destroy the worktree. */
  committed: boolean;
  /**
   * Whether a commit was attempted and did not happen, which means work the agent wrote is in the
   * worktree and in no history. The `finally` that destroys the worktree is then the only thing
   * between that work and `worktree remove --force`, so this keeps it — for a refusal, where the
   * tree is also the evidence, and for the ordinary failures of `status`, `add`, `commit` and
   * `rev-parse`, where it is simply the one copy (BP-506).
   *
   * Where it stops, said rather than left to be discovered: a step that never reaches its commit —
   * a timeout, a usage limit, a block — does not set this, and the tree goes, as it did before.
   * Those are the agent failing rather than the commit failing, and the usage-limit case is
   * deliberately kept that way (the same machine runs the task again).
   */
  uncommittedWork: boolean;
  /** Every sha this run created, oldest first. The only thing that commits here is commitAll. */
  commits: string[];
  /** What has already reached the remote, so an interrupted run can say where the work is. */
  pushed: boolean;
  prUrl: string;
  merged: boolean;
  summary: string;
  /** A gate's context takes one result and a composed agent produces several; the last is the honest one. */
  lastResult: ExecutionResult;
}

export interface StepContext {
  worktreePath: string;
  branch: string;
  task: ClaimedTask;
  executor: Executor;
  delivery: Delivery;
  commit: (message: string) => Promise<string>;
  state: RunState;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  baseSha: string;
  runner: Runner;
  gitPath: string;
}

// A push or a merge that throws must not reach the pipeline's outer catch: that requeues and
// destroys the worktree, and after a failed push the worktree is the only copy of the work.
async function runWorkerAction(
  entry: SnapshotEntry,
  ctx: StepContext,
): Promise<StepOutcome> {
  try {
    return await deliver(entry, ctx);
  } catch (error) {
    return { kind: "error", message: String(error) };
  }
}

async function deliver(
  entry: SnapshotEntry,
  ctx: StepContext,
): Promise<StepOutcome> {
  switch (entry.key) {
    case "push": {
      const wrong = await unexpectedHistory(
        ctx.runner,
        ctx.gitPath,
        ctx.worktreePath,
        ctx.baseSha,
        ctx.state.commits,
      );
      if (wrong)
        return { kind: "error", message: `refusing to push: ${wrong}` };
      await ctx.delivery.push(
        ctx.worktreePath,
        ctx.branch,
        ctx.state.commits[ctx.state.commits.length - 1] ?? "",
      );
      ctx.state.pushed = true;
      return { kind: "ok" };
    }

    case "pull-request":
      ctx.state.prUrl = await ctx.delivery.openPr(
        ctx.worktreePath,
        ctx.task,
        ctx.state.summary,
      );
      return { kind: "ok" };

    case "merge":
      // agentProblems refuses this shape on save, but a snapshot taken before that rule existed
      // still has to fail loudly rather than merge nothing and report a delivery
      if (!ctx.state.prUrl) {
        return {
          kind: "error",
          message: "the merge step ran with no pull request to merge",
        };
      }
      await ctx.delivery.merge(ctx.worktreePath, ctx.state.prUrl);
      ctx.state.merged = true;
      return { kind: "ok" };

    default:
      return {
        kind: "error",
        message: `this worker implements no action named ${entry.key}`,
      };
  }
}

/** One position in the sequence: a call to the model, or something the worker does itself. */
export async function runStep(
  entry: SnapshotEntry,
  ctx: StepContext,
): Promise<StepOutcome> {
  if (entry.deterministic) return runWorkerAction(entry, ctx);

  const outcome = await ctx.executor.execute({
    task: ctx.task,
    worktreePath: ctx.worktreePath,
    signal: ctx.signal,
    onEvent: ctx.onEvent,
    brief: {
      prompt: entry.prompt ?? "",
      capability: entry.capability ?? "read-only",
      model: entry.model ?? "",
      fallbackModel: entry.fallbackModel ?? "",
      timeoutMs: ctx.timeoutMs,
    },
  });

  if (outcome.kind === "usage_limit") return { kind: "usage_limit" };
  if (outcome.kind === "timeout") return { kind: "timeout" };
  if (outcome.kind === "machine_fault")
    return { kind: "machine_fault", message: outcome.message };
  if (outcome.kind === "error")
    return { kind: "error", message: outcome.message };
  if (outcome.result.status === "blocked") {
    return { kind: "blocked", reason: outcome.result.blockedReason };
  }

  ctx.state.summary = outcome.result.summary || ctx.state.summary;
  ctx.state.lastResult = outcome.result;

  // Only a step that could write has anything to commit. A commit that fails is the step's failure:
  // letting it throw would reach the pipeline's outer catch, which destroys the worktree holding the
  // only copy of the work.
  if (entry.capability === "edit") {
    try {
      const sha = await ctx.commit(
        `${ctx.task.taskKey}: ${entry.name.toLowerCase()}`,
      );
      if (sha) ctx.state.commits.push(sha);
      // Sticky, not overwritten: a later edit step that finds nothing to commit must not erase what
      // an earlier one already did.
      ctx.state.committed = ctx.state.committed || sha !== "";
    } catch (error) {
      // Set before anything is returned, and for every failure rather than the refusal alone: what
      // the agent wrote is in the worktree and in no history, whichever call threw.
      ctx.state.uncommittedWork = true;
      if (error instanceof TamperedCheckoutError) {
        return { kind: "tampered", finding: error.finding, message: error.message };
      }
      return { kind: "error", message: String(error) };
    }
  }

  return { kind: "ok" };
}
