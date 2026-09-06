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
  | { kind: "error"; message: string };

export interface RunState {
  committed: boolean;
  commits: string[];
  pushed: boolean;
  prUrl: string;
  merged: boolean;
  summary: string;
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
  configBaseline?: readonly string[] | null;
  runner: Runner;
}

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
        ctx.configBaseline,
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
  if (outcome.kind === "error")
    return { kind: "error", message: outcome.message };
  if (outcome.result.status === "blocked") {
    return { kind: "blocked", reason: outcome.result.blockedReason };
  }

  ctx.state.summary = outcome.result.summary || ctx.state.summary;
  ctx.state.lastResult = outcome.result;

  if (entry.capability === "edit") {
    try {
      const sha = await ctx.commit(
        `${ctx.task.taskKey}: ${entry.name.toLowerCase()}`,
      );
      if (sha) ctx.state.commits.push(sha);
      ctx.state.committed = ctx.state.committed || sha !== "";
    } catch (error) {
      return { kind: "error", message: String(error) };
    }
  }

  return { kind: "ok" };
}
