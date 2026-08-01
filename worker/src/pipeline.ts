import { ApiClient, StatusIds } from "./api.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { Reporter } from "./reporter.js";
import { Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, Gate, GateContext, GateResult } from "./types.js";

export interface PipelineDeps {
  config: WorkerConfig;
  api: ApiClient;
  columnIds: () => Promise<string[]>;
  createReporter: (api: ApiClient, statusIds: StatusIds) => Reporter;
  createDelivery: (runner: Runner, baseBranch?: string) => Delivery;
  workspace: Workspace;
  executor: Executor;
  collectDiff: (runner: Runner, worktreePath: string, baseBranch: string) => Promise<DiffStats>;
  runner: Runner;
  gates: Gate[];
  signal?: AbortSignal;
}

const SLUG = "worker";
const GIT_TIMEOUT_MS = 60_000;
const ROLES = ["approved", "review", "done"] as const;

export async function resolveStatusIds(
  api: Pick<ApiClient, "statusIds">,
  columnIds: () => Promise<string[]>
): Promise<StatusIds> {
  const [statusIds, ids] = await Promise.all([api.statusIds(), columnIds()]);
  const columns = new Set(ids);
  const unroutable = ROLES.filter((role) => !columns.has(statusIds[role]));
  if (unroutable.length === 0) return statusIds;

  const detail = unroutable.map((role) => `${role} -> "${statusIds[role]}"`).join(", ");
  throw new Error(`the board has no column for ${detail}, so a run could not be routed out of it`);
}

// GateResult has no third state, so a gate that could not reach a verdict at all because the
// CLI ran out of subscription is a release, not a rejection a human has to clear
function hitUsageLimit(verdict: GateResult): boolean {
  return /could not be completed/i.test(verdict.reason) && /usage limit reached/i.test(verdict.reason);
}

async function unfinishedWork(runner: Runner, worktreePath: string): Promise<string | null> {
  const result = await runner.run("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.timedOut) return `\`git status\` timed out after ${GIT_TIMEOUT_MS}ms`;
  if (result.code !== 0) return `\`git status\` failed: ${result.stderr || result.stdout}`;
  return result.stdout.trim() || null;
}

async function pushFailure(
  delivery: Delivery,
  worktreePath: string,
  branch: string
): Promise<string | null> {
  try {
    await delivery.push(worktreePath, branch);
    return null;
  } catch (error) {
    return String(error);
  }
}

async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
}

// An operator's stop is not the task's failure — released refunds the attempt, where requeued
// would charge it and eventually park the task in review as "gave up"
async function releaseIfAborted(
  deps: PipelineDeps,
  reporter: Reporter,
  task: ClaimedTask
): Promise<boolean> {
  if (!deps.signal?.aborted) return false;
  await reporter.released(task, "the run was stopped");
  return true;
}

export async function runTask(deps: PipelineDeps, task: ClaimedTask): Promise<void> {
  const { config, workspace, executor, gates, runner } = deps;
  const branch = `${task.taskKey.toLowerCase()}/${SLUG}`;

  let statusIds: StatusIds;
  try {
    statusIds = await resolveStatusIds(deps.api, deps.columnIds);
  } catch (error) {
    // Without a validated review column the queue is the only move left that cannot strand the task
    await quietly(() => deps.api.comment(task.taskId, `Returned to the queue: ${String(error)}`));
    await quietly(() => deps.api.release(task.taskId));
    return;
  }

  const reporter = deps.createReporter(deps.api, statusIds);
  const delivery = deps.createDelivery(runner, config.baseBranch);

  let worktreePath: string;
  try {
    worktreePath = await workspace.create(task.taskKey, SLUG);
  } catch (error) {
    await quietly(() => workspace.destroy(task.taskKey));
    await reporter.requeued(task, `could not create a worktree: ${String(error)}`);
    return;
  }

  let keepWorktree = false;
  try {
    const outcome = await executor.execute(task, worktreePath, deps.signal);

    if (outcome.kind === "usage_limit") {
      await reporter.released(task, "usage limit reached");
      return;
    }
    if (outcome.kind === "timeout") {
      await reporter.requeued(task, `the run timed out after ${config.taskTimeoutMs}ms`);
      return;
    }
    if (outcome.kind === "error") {
      await reporter.requeued(task, outcome.message);
      return;
    }
    if (outcome.result.status === "blocked") {
      await reporter.blocked(task, outcome.result.blockedReason);
      return;
    }

    const leftover = await unfinishedWork(runner, worktreePath);
    if (leftover) {
      keepWorktree = true;
      await reporter.failed(
        task,
        `the executor left the worktree unclean, so the gates would judge a diff that is not what is on disk — and the reviewer would load whatever was never committed:\n\n${leftover}\n\nNothing was pushed; the worktree is kept at \`${worktreePath}\` on the worker host.`
      );
      return;
    }

    const diff = await deps.collectDiff(runner, worktreePath, config.baseBranch);
    const context: GateContext = { worktreePath, task, result: outcome.result, diff, signal: deps.signal };

    for (const gate of gates) {
      if (await releaseIfAborted(deps, reporter, task)) return;

      const verdict = await gate.run(context);
      if (verdict.ok) continue;

      if (hitUsageLimit(verdict)) {
        await reporter.released(task, `the ${gate.name} gate could not run: ${verdict.reason}`);
        return;
      }

      // The worktree goes next, so the pushed branch is the only copy a human can reach
      const failure = await pushFailure(delivery, worktreePath, branch);
      if (failure) keepWorktree = true;
      await reporter.gateRejected(
        task,
        gate.name,
        failure
          ? `${verdict.reason}\n\n**The branch was not pushed**: ${failure}. \`${branch}\` is not on the remote — this work exists only in the worktree at \`${worktreePath}\` on the worker host.`
          : verdict.reason,
        branch
      );
      return;
    }

    if (await releaseIfAborted(deps, reporter, task)) return;

    let prUrl = "";
    try {
      await delivery.push(worktreePath, branch);
      if (await releaseIfAborted(deps, reporter, task)) return;

      prUrl = await delivery.openPr(worktreePath, task, outcome.result.summary);
      if (await releaseIfAborted(deps, reporter, task)) return;

      // No signal on the merge call itself: killing "gh pr merge" mid-flight leaves ambiguous
      // remote state that only mergeState() can untangle — better not to create it
      await delivery.merge(worktreePath, prUrl);
    } catch (error) {
      keepWorktree = true;
      await reporter.failed(
        task,
        `could not deliver \`${branch}\`${prUrl ? ` (${prUrl})` : ""}: ${String(error)}\n\nThe worktree is kept at \`${worktreePath}\` on the worker host, with the branch checked out.`
      );
      return;
    }

    await reporter.merged(task, prUrl, outcome.result.summary);
  } catch (error) {
    await reporter.requeued(task, `the worker hit an unexpected error: ${String(error)}`);
  } finally {
    if (!keepWorktree) {
      await quietly(() => workspace.destroy(task.taskKey));
    }
  }
}
