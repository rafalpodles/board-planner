import { ApiClient, StatusIds } from "./api.js";
import { createBudget } from "./budget.js";
import { commitAll } from "./commit.js";
import { WorkerConfig } from "./config.js";
import { GateFallbacks } from "./gates/from-entry.js";
import { unexpectedHistory } from "./provenance.js";
import { RunState, runStep } from "./steps.js";
import { recordFor, RunRecord } from "./run-record.js";
import { isResultEvent, StreamEvent } from "./stream.js";
import { Delivery } from "./delivery.js";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";
import { Reporter } from "./reporter.js";
import { SHUTDOWN_SIGNAL } from "./commands.js";
import { scrub } from "./scrub.js";
import { OutcomeKind, Phase, Telemetry } from "./telemetry.js";
import {
  BaseUnavailableError,
  PoisonedCheckoutError,
  Workspace,
  Worktree,
} from "./workspace.js";
import {
  ClaimedTask,
  DiffStats,
  ExecutionResult,
  Gate,
  GateResult,
  SnapshotEntry,
} from "./types.js";

export interface PipelineDeps {
  config: WorkerConfig;
  api: ApiClient;
  columnIds: (projectId: string) => Promise<string[]>;
  createReporter: (api: ApiClient, statusIds: StatusIds) => Reporter;
  createDelivery: (runner: Runner, baseBranch?: string) => Delivery;
  workspace: Workspace;
  executor: Executor;
  collectDiff: (
    runner: Runner,
    worktreePath: string,
    baseSha: string,
  ) => Promise<DiffStats>;
  gateFor: (
    entry: SnapshotEntry,
    runner: Runner,
    timeoutMs: number,
    fallbacks: GateFallbacks,
  ) => Gate | null;
  runner: Runner;
  recordRun: (projectId: string, record: RunRecord) => void;
  signal?: AbortSignal;
  logError?: (message: string) => void;
  quarantineProject: (projectId: string, reason: string) => void;
  now?: () => number;
  telemetry?: Pick<Telemetry, "emit" | "emitEvent">;
}

const SLUG = "worker";

const MAX_DETAIL_CHARS = 200;
const GIT_TIMEOUT_MS = 60_000;
const ROLES = ["approved", "review", "done"] as const;

export async function resolveStatusIds(
  api: Pick<ApiClient, "statusIds">,
  columnIds: (projectId: string) => Promise<string[]>,
  projectId: string,
): Promise<StatusIds> {
  const [statusIds, ids] = await Promise.all([
    api.statusIds(projectId),
    columnIds(projectId),
  ]);
  const columns = new Set(ids);
  const unroutable = ROLES.filter((role) => !columns.has(statusIds[role]));
  if (unroutable.length === 0) return statusIds;

  const detail = unroutable
    .map((role) =>
      statusIds[role]
        ? `${role} -> "${statusIds[role]}"`
        : `${role} (no column carries that role)`,
    )
    .join(", ");
  throw new Error(
    `the board has no column for ${detail}, so a run could not be routed out of it`,
  );
}

function hitUsageLimit(verdict: GateResult): boolean {
  return (
    /could not be completed/i.test(verdict.reason) &&
    /usage limit reached/i.test(verdict.reason)
  );
}

const GATE_CAP_MS = 600_000;

const MIN_ENTRY_MS = 30_000;

const EMPTY_RESULT: ExecutionResult = {
  status: "completed",
  summary: "",
  filesChanged: [],
  testsAdded: [],
  blockedReason: "",
};

const DELIVERY_PHASES: Record<string, Phase> = {
  push: "push",
  "pull-request": "pr",
  merge: "merge",
};

function phaseFor(entry: SnapshotEntry): Phase {
  if (entry.kind === "gate") return `gates:${entry.key}`;
  return DELIVERY_PHASES[entry.key] ?? `step:${entry.key}`;
}

function unpushedWork(state: RunState, worktreePath: string): string {
  if (!state.committed || state.pushed) return "";
  return `\n\nAn earlier step had already committed. That work is not pushed; the worktree is kept at \`${worktreePath}\` on the worker host.`;
}

function whatLanded(state: RunState, branch: string): string {
  if (state.merged) return "";
  if (state.prUrl)
    return `: \`${branch}\` is pushed and ${state.prUrl} is open, but it was not merged`;
  if (state.pushed)
    return `: \`${branch}\` is pushed, but no pull request was opened for it`;
  return "";
}

async function unfinishedWork(
  runner: Runner,
  worktreePath: string,
): Promise<string | null> {
  const result = await runner.run("git", gitArgs(["status", "--porcelain"]), {
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), ...GIT_SAFE_ENV },
  });
  if (result.timedOut)
    return `\`git status\` timed out after ${GIT_TIMEOUT_MS}ms`;
  if (result.code !== 0)
    return `\`git status\` failed: ${result.stderr || result.stdout}`;
  return result.stdout.trim() || null;
}

async function pushFailure(
  runner: Runner,
  baseSha: string,
  expected: string[],
  delivery: Delivery,
  worktreePath: string,
  branch: string,
  commit: string,
  configBaseline?: readonly string[] | null,
): Promise<string | null> {
  const wrong = await unexpectedHistory(
    runner,
    worktreePath,
    baseSha,
    expected,
  );
  if (wrong) return `refusing to push: ${wrong}`;
  try {
    await delivery.push(worktreePath, branch, commit, configBaseline);
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

async function releaseIfAborted(
  deps: PipelineDeps,
  reporter: Reporter,
  task: ClaimedTask,
  detail = "",
): Promise<boolean> {
  if (!deps.signal?.aborted) return false;
  const stoppedByProcessSignal = deps.signal.reason === SHUTDOWN_SIGNAL;
  const report = stoppedByProcessSignal ? reporter.requeued : reporter.released;
  deps.telemetry?.emit({
    outcome: stoppedByProcessSignal ? "requeued" : "released",
    taskKey: task.taskKey,
    detail: "the run was stopped",
  });
  await report(task, `the run was stopped${detail}`);
  return true;
}

export type RunDisposition = void | "machine-fault";

export async function runTask(
  deps: PipelineDeps,
  task: ClaimedTask,
): Promise<RunDisposition> {
  const { config, workspace, executor, runner, telemetry } = deps;
  const now = deps.now ?? Date.now;
  const branch = `${task.taskKey.toLowerCase()}/${SLUG}`;

  const enter = (phase: Phase): void =>
    telemetry?.emit({ phase, taskKey: task.taskKey });

  const startedAt = now();
  let costUsd = 0;

  const settle = (outcome: OutcomeKind, detail?: string): void => {
    telemetry?.emit(
      detail === undefined
        ? { outcome, taskKey: task.taskKey }
        : {
            outcome,
            taskKey: task.taskKey,
            detail: scrub(detail).slice(0, MAX_DETAIL_CHARS),
          },
    );
    deps.recordRun(
      task.projectId,
      recordFor(task, outcome, scrub(detail ?? ""), startedAt, now(), costUsd),
    );
  };

  const onEvent = (event: StreamEvent): void => {
    if (isResultEvent(event) && typeof event.total_cost_usd === "number") {
      costUsd += event.total_cost_usd;
    }
    telemetry?.emitEvent(event);
  };

  enter("claiming");

  let statusIds: StatusIds;
  try {
    statusIds = await resolveStatusIds(
      deps.api,
      deps.columnIds,
      task.projectId,
    );
  } catch (error) {
    await quietly(() =>
      deps.api.comment(
        task.projectId,
        task.taskId,
        scrub(`Returned to the queue: ${String(error)}`),
      ),
    );
    await quietly(() => deps.api.release(task.projectId, task.taskId, { refund: false }));
    settle("released", "the board could not route the outcome");
    return;
  }

  const reporter = deps.createReporter(deps.api, statusIds);
  const delivery = deps.createDelivery(runner, config.baseBranch);

  let worktree: Worktree;
  try {
    enter("worktree");
    worktree = await workspace.create(task.taskKey, SLUG);
  } catch (error) {
    await quietly(() => workspace.destroy(task.taskKey));
    if (error instanceof PoisonedCheckoutError) {
      deps.logError?.(`${task.taskKey}: ${String(error)}`);
      if (error.kind === "planted") {
        deps.quarantineProject(task.projectId, error.finding);
      }
      settle(
        "released",
        error.kind === "planted"
          ? "the checkout's git config carries an executable key"
          : "the checkout's git config could not be read"
      );
      await reporter.released(task, String(error));
      return "machine-fault";
    }
    if (error instanceof BaseUnavailableError) {
      deps.logError?.(`${task.taskKey}: ${String(error)}`);
      if (error.kind === "configuration") {
        settle(
          "requeued",
          "the base branch is not configured for this repository",
        );
        await reporter.requeued(task, String(error));
        return;
      }
      settle("released", "the base branch could not be established");
      await reporter.released(task, String(error));
      return "machine-fault";
    }
    settle("requeued", "could not create a worktree");
    await reporter.requeued(
      task,
      `could not create a worktree: ${String(error)}`,
    );
    return;
  }

  let keepWorktree = false;
  const state: RunState = {
    committed: false,
    commits: [],
    pushed: false,
    prUrl: "",
    merged: false,
    summary: "",
    lastResult: EMPTY_RESULT,
  };

  try {
    const budget = createBudget(config.runCeilingMs, now);

    for (const entry of task.agent.sequence) {
      if (
        await releaseIfAborted(deps, reporter, task, whatLanded(state, branch))
      )
        return;

      if (budget.exhausted() || budget.remaining() < MIN_ENTRY_MS) {
        settle("requeued", "the run hit its ceiling");
        await reporter.requeued(
          task,
          `the run hit its ceiling of ${config.runCeilingMs}ms before reaching ${entry.name}`,
        );
        return;
      }

      enter(phaseFor(entry));

      if (entry.kind === "step") {
        const outcome = await runStep(entry, {
          worktreePath: worktree.path,
          branch,
          task,
          executor,
          delivery,
          commit: (message) =>
            commitAll(runner, worktree.path, message, worktree.configBaseline),
          state,
          timeoutMs: budget.forEntry(config.taskTimeoutMs),
          signal: deps.signal,
          onEvent,
          baseSha: worktree.baseSha,
          configBaseline: worktree.configBaseline,
          runner,
        });
        if (
          !state.merged &&
          (await releaseIfAborted(
            deps,
            reporter,
            task,
            whatLanded(state, branch),
          ))
        ) {
          return;
        }

        if (outcome.kind !== "ok" && state.committed) keepWorktree = true;

        if (outcome.kind === "usage_limit") {
          settle("released", "usage limit reached");
          await reporter.released(
            task,
            `usage limit reached${unpushedWork(state, worktree.path)}`,
          );
          return;
        }
        if (outcome.kind === "timeout") {
          settle("requeued", `${entry.name} timed out`);
          await reporter.requeued(task, `${entry.name} timed out`);
          return;
        }
        if (outcome.kind === "blocked") {
          settle("blocked", outcome.reason);
          await reporter.blocked(
            task,
            `${outcome.reason}${unpushedWork(state, worktree.path)}`,
          );
          return;
        }
        if (outcome.kind === "error") {
          if (entry.deterministic) {
            keepWorktree = true;
            settle("failed", outcome.message);
            await reporter.failed(
              task,
              `${entry.name} failed${whatLanded(state, branch)}: ${outcome.message}\n\nThe worktree is kept at \`${worktree.path}\` on the worker host, with the branch checked out.`,
            );
          } else {
            settle("requeued", outcome.message);
            await reporter.requeued(
              task,
              `${entry.name} failed: ${outcome.message}`,
            );
          }
          return;
        }
      } else {
        const gate = deps.gateFor(entry, runner, budget.forEntry(GATE_CAP_MS), {
          maxDiffLines: config.maxDiffLines,
          maxDiffFiles: config.maxDiffFiles,
          reviewModel: config.reviewModel ?? "",
        });
        if (!gate) {
          keepWorktree = true;
          settle("failed", `no gate named ${entry.key}`);
          await reporter.failed(
            task,
            `this worker implements no gate of kind ${JSON.stringify(entry.gateKind ?? "")} (${entry.key}), so the agent could not be run as it was composed. Nothing was pushed; the worktree is kept at \`${worktree.path}\` on the worker host.`,
          );
          return;
        }

        const diff = await deps.collectDiff(
          runner,
          worktree.path,
          worktree.baseSha,
        );
        const verdict = await gate.run({
          worktreePath: worktree.path,
          configBaseline: worktree.configBaseline,
          task,
          result: state.lastResult,
          diff,
          signal: deps.signal,
        });
        if (await releaseIfAborted(deps, reporter, task)) return;

        if (!verdict.ok) {
          if (hitUsageLimit(verdict)) {
            settle("released", `the ${gate.name} gate could not run`);
            await reporter.released(
              task,
              `the ${gate.name} gate could not run: ${verdict.reason}`,
            );
            return;
          }

          const withholdsPush = entry.gateKind === "protected-paths";
          const pushFailed = withholdsPush
            ? null
            : await pushFailure(
                runner,
                worktree.baseSha,
                state.commits,
                delivery,
                worktree.path,
                branch,
                state.commits[state.commits.length - 1] ?? "",
                worktree.configBaseline,
              );
          if (withholdsPush || pushFailed) keepWorktree = true;

          settle("gateRejected", gate.name);
          await reporter.gateRejected(
            task,
            gate.name,
            withholdsPush
              ? `${verdict.reason}\n\n**The branch was not pushed**, on purpose: what it carries is exactly what this gate refused. The work is in the worktree at \`${worktree.path}\` on the worker host.`
              : pushFailed
                ? `${verdict.reason}\n\n**The branch was not pushed**: ${pushFailed}. \`${branch}\` is not on the remote — this work exists only in the worktree at \`${worktree.path}\` on the worker host.`
                : verdict.reason,
            withholdsPush || pushFailed ? "" : branch,
            diff.patch,
          );
          return;
        }
      }

      if (entry.kind !== "step" || entry.capability !== "edit") continue;

      const leftover = await unfinishedWork(runner, worktree.path);
      if (leftover) {
        keepWorktree = true;
        settle("failed", `${entry.name} left the worktree unclean`);
        await reporter.failed(
          task,
          `${entry.name} left the worktree unclean, so anything after it would judge a tree that is not what was committed:\n\n${leftover}\n\nNothing was pushed; the worktree is kept at \`${worktree.path}\` on the worker host.`,
        );
        return;
      }
    }

    if (
      !state.merged &&
      (await releaseIfAborted(deps, reporter, task, whatLanded(state, branch)))
    ) {
      return;
    }

    if (state.merged) {
      settle("merged");
      await reporter.merged(task, state.prUrl, state.summary);
    } else {
      settle("delivered", state.prUrl);
      await reporter.delivered(task, state.prUrl, state.summary);
    }
  } catch (error) {
    settle("requeued", "the worker hit an unexpected error");
    await reporter.requeued(
      task,
      `the worker hit an unexpected error: ${String(error)}`,
    );
  } finally {
    if (!keepWorktree) {
      await quietly(() => workspace.destroy(task.taskKey));
    }
  }
}
