import { ApiClient, StatusIds } from "./api.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { Reporter } from "./reporter.js";
import { SHUTDOWN_SIGNAL } from "./commands.js";
import { scrub } from "./scrub.js";
import { Phase, Telemetry } from "./telemetry.js";
import { Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, Gate, GateContext, GateResult } from "./types.js";

export interface PipelineDeps {
  config: WorkerConfig;
  api: ApiClient;
  columnIds: (projectId: string) => Promise<string[]>;
  createReporter: (api: ApiClient, statusIds: StatusIds) => Reporter;
  createDelivery: (runner: Runner, baseBranch?: string) => Delivery;
  workspace: Workspace;
  executor: Executor;
  collectDiff: (runner: Runner, worktreePath: string, baseBranch: string) => Promise<DiffStats>;
  runner: Runner;
  gates: Gate[];
  signal?: AbortSignal;
  // Where the run says what it is doing. Left out entirely, the run behaves exactly as it did
  // before there was anything to say it to.
  telemetry?: Pick<Telemetry, "emit" | "emitEvent">;
}

const SLUG = "worker";
const GIT_TIMEOUT_MS = 60_000;
const ROLES = ["approved", "review", "done"] as const;

export async function resolveStatusIds(
  api: Pick<ApiClient, "statusIds">,
  columnIds: (projectId: string) => Promise<string[]>,
  projectId: string
): Promise<StatusIds> {
  const [statusIds, ids] = await Promise.all([api.statusIds(projectId), columnIds(projectId)]);
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

// Same neutralisation as diff.ts and delivery.ts: this worktree comes from a server-proposed,
// locally-approved repository, but the approval happens once at bind time — its gitconfig still
// fires on every git call unless each one, not just the one at bind time, is protected too.
async function unfinishedWork(runner: Runner, worktreePath: string): Promise<string | null> {
  const result = await runner.run("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "status", "--porcelain"], {
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), GIT_CONFIG_NOSYSTEM: "1" },
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
// would charge it and eventually park the task in review as "gave up". Checked on both sides of
// every phase that spawns: a killed child settles as an ordinary non-zero exit, indistinguishable
// from a real build failure by the time the verdict is read.
async function releaseIfAborted(
  deps: PipelineDeps,
  reporter: Reporter,
  task: ClaimedTask,
  detail = ""
): Promise<boolean> {
  if (!deps.signal?.aborted) return false;
  // A signal-driven shutdown charges the attempt; an operator's explicit stop does not. See
  // SHUTDOWN_SIGNAL for why the distinction matters.
  const stoppedByProcessSignal = deps.signal.reason === SHUTDOWN_SIGNAL;
  const report = stoppedByProcessSignal ? reporter.requeued : reporter.released;
  await report(task, `the run was stopped${detail}`);
  return true;
}

export async function runTask(deps: PipelineDeps, task: ClaimedTask): Promise<void> {
  const { config, workspace, executor, gates, runner, telemetry } = deps;
  const branch = `${task.taskKey.toLowerCase()}/${SLUG}`;

  // Coarse on purpose: a phase names the stage a run is in, and every stage below either finishes
  // or ends the run, so the last one emitted is always where the run actually is.
  const enter = (phase: Phase): void => telemetry?.emit({ phase });

  enter("claiming");

  let statusIds: StatusIds;
  try {
    statusIds = await resolveStatusIds(deps.api, deps.columnIds, task.projectId);
  } catch (error) {
    // Without a validated review column the queue is the only move left that cannot strand the task.
    // This comment does not go through the reporter, so it needs its own scrub.
    await quietly(() =>
      deps.api.comment(task.projectId, task.taskId, scrub(`Returned to the queue: ${String(error)}`))
    );
    await quietly(() => deps.api.release(task.projectId, task.taskId));
    return;
  }

  const reporter = deps.createReporter(deps.api, statusIds);
  const delivery = deps.createDelivery(runner, config.baseBranch);

  let worktreePath: string;
  try {
    enter("worktree");
    worktreePath = await workspace.create(task.taskKey, SLUG);
  } catch (error) {
    await quietly(() => workspace.destroy(task.taskKey));
    await reporter.requeued(task, `could not create a worktree: ${String(error)}`);
    return;
  }

  let keepWorktree = false;
  try {
    enter("agent");
    // The only agent-authored material that reaches a sink, and it reaches one only through
    // summarise(), whose result type cannot hold a file body, a prompt or a diff
    const outcome = await executor.execute(
      task,
      worktreePath,
      deps.signal,
      telemetry && ((event) => telemetry.emitEvent(event))
    );
    if (await releaseIfAborted(deps, reporter, task)) return;

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

      enter(`gates:${gate.name}`);
      const verdict = await gate.run(context);
      if (await releaseIfAborted(deps, reporter, task)) return;
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
      enter("push");
      await delivery.push(worktreePath, branch);
      if (
        await releaseIfAborted(
          deps,
          reporter,
          task,
          `: \`${branch}\` is pushed, but no pull request was opened for it`
        )
      ) {
        return;
      }

      enter("pr");
      prUrl = await delivery.openPr(worktreePath, task, outcome.result.summary);
      if (
        await releaseIfAborted(
          deps,
          reporter,
          task,
          `: \`${branch}\` is pushed and ${prUrl} is open, but it was not merged`
        )
      ) {
        return;
      }

      // No signal on the merge call itself: killing "gh pr merge" mid-flight leaves ambiguous
      // remote state that only mergeState() can untangle — better not to create it
      enter("merge");
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
