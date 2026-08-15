import { Delivery } from "./delivery.js";
import { Executor } from "./executor.js";
import { StreamEvent } from "./stream.js";
import { ClaimedTask, ExecutionResult, SnapshotEntry } from "./types.js";

export type StepOutcome =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "usage_limit" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export interface RunState {
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
  commit: (message: string) => Promise<void>;
  state: RunState;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

async function runWorkerAction(entry: SnapshotEntry, ctx: StepContext): Promise<StepOutcome> {
  switch (entry.key) {
    case "push":
      await ctx.delivery.push(ctx.worktreePath, ctx.branch);
      return { kind: "ok" };

    case "pull-request":
      ctx.state.prUrl = await ctx.delivery.openPr(ctx.worktreePath, ctx.task, ctx.state.summary);
      return { kind: "ok" };

    case "merge":
      // agentProblems refuses this shape on save, but a snapshot taken before that rule existed
      // still has to fail loudly rather than merge nothing and report a delivery
      if (!ctx.state.prUrl) {
        return { kind: "error", message: "the merge step ran with no pull request to merge" };
      }
      await ctx.delivery.merge(ctx.worktreePath, ctx.state.prUrl);
      ctx.state.merged = true;
      return { kind: "ok" };

    default:
      return { kind: "error", message: `this worker implements no action named ${entry.key}` };
  }
}

/** One position in the sequence: a call to the model, or something the worker does itself. */
export async function runStep(entry: SnapshotEntry, ctx: StepContext): Promise<StepOutcome> {
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
  if (outcome.kind === "error") return { kind: "error", message: outcome.message };
  if (outcome.result.status === "blocked") {
    return { kind: "blocked", reason: outcome.result.blockedReason };
  }

  ctx.state.summary = outcome.result.summary || ctx.state.summary;
  ctx.state.lastResult = outcome.result;

  // Only a step that could write has anything to commit
  if (entry.capability === "edit") {
    await ctx.commit(`${ctx.task.taskKey}: ${entry.name.toLowerCase()}`);
  }

  return { kind: "ok" };
}
