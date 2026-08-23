import { ApiClient, StatusIds } from "./api.js";
import { createBudget } from "./budget.js";
import { commitAll } from "./commit.js";
import { WorkerConfig } from "./config.js";
import { GateFallbacks } from "./gates/from-entry.js";
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
import { Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, ExecutionResult, Gate, GateResult, SnapshotEntry } from "./types.js";

export interface PipelineDeps {
  config: WorkerConfig;
  api: ApiClient;
  columnIds: (projectId: string) => Promise<string[]>;
  createReporter: (api: ApiClient, statusIds: StatusIds) => Reporter;
  createDelivery: (runner: Runner, baseBranch?: string) => Delivery;
  workspace: Workspace;
  executor: Executor;
  collectDiff: (runner: Runner, worktreePath: string, baseBranch: string) => Promise<DiffStats>;
  // Injected like every other collaborator here, so a test can watch what a gate was given without
  // standing up the gate itself. wiring.ts supplies the real one.
  gateFor: (
    entry: SnapshotEntry,
    runner: Runner,
    timeoutMs: number,
    fallbacks: GateFallbacks
  ) => Gate | null;
  runner: Runner;
  // Fire and forget, onto the outbox: a record that fails to post must not turn a delivered run
  // into a failed one, and must not be lost to the redeploy a merge triggers either.
  recordRun: (projectId: string, record: RunRecord) => void;
  signal?: AbortSignal;
  /** Injected only so a test can move the run's clock; the run itself reads the wall clock. */
  now?: () => number;
  // Where the run says what it is doing. Left out entirely, the run behaves exactly as it did
  // before there was anything to say it to.
  telemetry?: Pick<Telemetry, "emit" | "emitEvent">;
}

const SLUG = "worker";

const MAX_DETAIL_CHARS = 200;
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

// A gate is bounded by the cap buildGates always applied — it bounds one npm install however large
// the run ceiling is. A model step is bounded by taskTimeoutMs, which is what bounded it before the
// sequence existed and what the project's "Timeout for one step" setting still means. Folding both
// into the gate cap silently cut every step from thirty minutes to ten.
const GATE_CAP_MS = 600_000;

// Below this there is no point starting anything: whatever it is would fail on the clock and be
// reported as its own verdict rather than as the ceiling.
const MIN_ENTRY_MS = 30_000;

const EMPTY_RESULT: ExecutionResult = {
  status: "completed",
  summary: "",
  filesChanged: [],
  testsAdded: [],
  blockedReason: "",
};

// The delivery steps keep the phase names the board and the menubar already know; only a model step
// names its own block, because that is the one an operator cannot otherwise see the shape of.
const DELIVERY_PHASES: Record<string, Phase> = {
  push: "push",
  "pull-request": "pr",
  merge: "merge",
};

function phaseFor(entry: SnapshotEntry): Phase {
  if (entry.kind === "gate") return `gates:${entry.key}`;
  return DELIVERY_PHASES[entry.key] ?? `step:${entry.key}`;
}

// Committed but unpushed work is invisible from the board, so an exit that leaves some has to say
// where it is — the branch ref alone does not survive the next attempt's `git worktree add -B`.
function unpushedWork(state: RunState, worktreePath: string): string {
  if (!state.committed || state.pushed) return "";
  return `\n\nAn earlier step had already committed. That work is not pushed; the worktree is kept at \`${worktreePath}\` on the worker host.`;
}

// A stop between the push and the merge leaves work on the remote, and the release comment is the
// only place that says so.
function whatLanded(state: RunState, branch: string): string {
  if (state.merged) return "";
  if (state.prUrl) return `: \`${branch}\` is pushed and ${state.prUrl} is open, but it was not merged`;
  if (state.pushed) return `: \`${branch}\` is pushed, but no pull request was opened for it`;
  return "";
}

async function unfinishedWork(runner: Runner, worktreePath: string): Promise<string | null> {
  const result = await runner.run("git", gitArgs(["status", "--porcelain"]), {
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), ...GIT_SAFE_ENV },
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
  deps.telemetry?.emit({
    outcome: stoppedByProcessSignal ? "requeued" : "released",
    taskKey: task.taskKey,
    detail: "the run was stopped",
  });
  await report(task, `the run was stopped${detail}`);
  return true;
}

export async function runTask(deps: PipelineDeps, task: ClaimedTask): Promise<void> {
  const { config, workspace, executor, runner, telemetry } = deps;
  const now = deps.now ?? Date.now;
  const branch = `${task.taskKey.toLowerCase()}/${SLUG}`;

  // Coarse on purpose: a phase names the stage a run is in, and every stage below either finishes
  // or ends the run, so the last one emitted is always where the run actually is.
  const enter = (phase: Phase): void => telemetry?.emit({ phase, taskKey: task.taskKey });

  // Emitted before the matching reporter call, so a reporter that throws cannot swallow the
  // operator's only local sign that the run ended. Detail takes the same redaction as board-bound
  // text: it reaches a Notification Center database that outlives the run.
  const startedAt = now();
  let costUsd = 0;

  // Every exit goes through here, which is what makes it the one place a run can be recorded from.
  const settle = (outcome: OutcomeKind, detail?: string): void => {
    telemetry?.emit(
      detail === undefined
        ? { outcome, taskKey: task.taskKey }
        : { outcome, taskKey: task.taskKey, detail: scrub(detail).slice(0, MAX_DETAIL_CHARS) }
    );
    deps.recordRun(
      task.projectId,
      recordFor(task, outcome, scrub(detail ?? ""), startedAt, now(), costUsd)
    );
  };

  // The CLI reports cost once per call, so a composed agent's cost is the sum across its steps.
  // Attached whether or not a bus is: this is the only place cost is measured. Gate cost is still
  // missed — review.ts runs with --output-format json and parseVerdict discards the envelope.
  const onEvent = (event: StreamEvent): void => {
    if (isResultEvent(event) && typeof event.total_cost_usd === "number") {
      costUsd += event.total_cost_usd;
    }
    telemetry?.emitEvent(event);
  };

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
    // settle, like every other exit: without it the menubar shows the run parked in "claiming"
    // for ever and no AgentRun is written for a task that was genuinely claimed and handed back.
    settle("released", "the board could not route the outcome");
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
    settle("requeued", "could not create a worktree");
    await reporter.requeued(task, `could not create a worktree: ${String(error)}`);
    return;
  }

  let keepWorktree = false;
  const state: RunState = {
    committed: false,
    pushed: false,
    prUrl: "",
    merged: false,
    summary: "",
    lastResult: EMPTY_RESULT,
  };

  try {
    const budget = createBudget(config.runCeilingMs, now);

    for (const entry of task.agent.sequence) {
      if (await releaseIfAborted(deps, reporter, task, whatLanded(state, branch))) return;

      // Not just exhausted: an entry handed the few seconds left would fail on the clock and be
      // reported as its own refusal — "blocked the merge at the build gate" for a build that never
      // ran. Below the floor the run is over, and the reason says so.
      if (budget.exhausted() || budget.remaining() < MIN_ENTRY_MS) {
        settle("requeued", "the run hit its ceiling");
        await reporter.requeued(
          task,
          `the run hit its ceiling of ${config.runCeilingMs}ms before reaching ${entry.name}`
        );
        return;
      }

      enter(phaseFor(entry));

      if (entry.kind === "step") {
        // The only agent-authored material that reaches a sink, and it reaches one only through
        // summarise(), whose result type cannot hold a file body, a prompt or a diff
        const outcome = await runStep(entry, {
          worktreePath,
          branch,
          task,
          executor,
          delivery,
          commit: (message) => commitAll(runner, worktreePath, message),
          state,
          timeoutMs: budget.forEntry(config.taskTimeoutMs),
          signal: deps.signal,
          onEvent,
        });
        // Never once the merge has landed — see the same guard after the loop. gh pr merge runs
        // without a signal, so the stop is only ever observed after the change is on the base
        // branch, and releasing there queues a second full run over work that has already landed.
        if (!state.merged && (await releaseIfAborted(deps, reporter, task, whatLanded(state, branch)))) {
          return;
        }

        // Only when this step ends the run. An earlier step may already have committed, and exiting
        // without keeping the worktree destroys the only copy of that work: nothing is pushed, and
        // the branch ref the parent clone holds is reset by the next attempt's `git worktree add -B`.
        if (outcome.kind !== "ok" && state.committed) keepWorktree = true;

        if (outcome.kind === "usage_limit") {
          settle("released", "usage limit reached");
          await reporter.released(task, `usage limit reached${unpushedWork(state, worktreePath)}`);
          return;
        }
        if (outcome.kind === "timeout") {
          settle("requeued", `${entry.name} timed out`);
          await reporter.requeued(task, `${entry.name} timed out`);
          return;
        }
        if (outcome.kind === "blocked") {
          settle("blocked", outcome.reason);
          await reporter.blocked(task, `${outcome.reason}${unpushedWork(state, worktreePath)}`);
          return;
        }
        if (outcome.kind === "error") {
          // A delivery step failing is the run's failure — a human has to look at the remote. A
          // model step failing is usually the CLI flaking ("could not parse claude output"), which
          // main retried inside the attempt budget; parking the task on one flake wastes a human.
          if (entry.deterministic) {
            keepWorktree = true;
            settle("failed", outcome.message);
            await reporter.failed(
              task,
              `${entry.name} failed${whatLanded(state, branch)}: ${outcome.message}\n\nThe worktree is kept at \`${worktreePath}\` on the worker host, with the branch checked out.`
            );
          } else {
            settle("requeued", outcome.message);
            await reporter.requeued(task, `${entry.name} failed: ${outcome.message}`);
          }
          return;
        }
      } else {
        const gate = deps.gateFor(entry, runner, budget.forEntry(GATE_CAP_MS), {
          maxDiffLines: config.maxDiffLines,
          maxDiffFiles: config.maxDiffFiles,
          reviewModel: config.reviewModel ?? "",
        });
        // Not skipped: skipping runs a shorter agent than the one somebody composed, and a missing
        // check looks exactly like a check that passed.
        if (!gate) {
          keepWorktree = true;
          settle("failed", `no gate named ${entry.key}`);
          await reporter.failed(
            task,
            `this worker implements no gate of kind ${JSON.stringify(entry.gateKind ?? "")} (${entry.key}), so the agent could not be run as it was composed. Nothing was pushed; the worktree is kept at \`${worktreePath}\` on the worker host.`
          );
          return;
        }

        const diff = await deps.collectDiff(runner, worktreePath, config.baseBranch);
        const verdict = await gate.run({
          worktreePath,
          task,
          result: state.lastResult,
          diff,
          signal: deps.signal,
        });
        if (await releaseIfAborted(deps, reporter, task)) return;

        if (!verdict.ok) {
          if (hitUsageLimit(verdict)) {
            settle("released", `the ${gate.name} gate could not run`);
            await reporter.released(task, `the ${gate.name} gate could not run: ${verdict.reason}`);
            return;
          }

          // The one refusal that must not push: a pushed branch carrying .github/workflows/*.yml
          // runs in Actions with the repository's secrets, whatever this verdict said.
          const withholdsPush = entry.gateKind === "protected-paths";
          // Otherwise the worktree goes next, so the pushed branch is the only copy a human reaches
          const pushFailed = withholdsPush
            ? null
            : await pushFailure(delivery, worktreePath, branch);
          if (withholdsPush || pushFailed) keepWorktree = true;

          settle("gateRejected", gate.name);
          await reporter.gateRejected(
            task,
            gate.name,
            withholdsPush
              ? `${verdict.reason}\n\n**The branch was not pushed**, on purpose: what it carries is exactly what this gate refused. The work is in the worktree at \`${worktreePath}\` on the worker host.`
              : pushFailed
                ? `${verdict.reason}\n\n**The branch was not pushed**: ${pushFailed}. \`${branch}\` is not on the remote — this work exists only in the worktree at \`${worktreePath}\` on the worker host.`
                : verdict.reason,
            withholdsPush ? "" : branch,
            // Only where no branch carries it. A patch in a comment executes nothing, and this
            // gate's demand is that a human read the change — which otherwise means a shell on
            // whichever machine happened to claim the task.
            diff.patch
          );
          return;
        }
      }

      // After every step that could write — not after a gate. With several steps an unclean tree
      // poisons everything after it, and a gate would judge a diff that is not what was committed.
      // Gates are the wrong place to ask: `build` runs npm ci and `test-run` runs the suite, so any
      // artifact the target repo does not gitignore would fail a run that did nothing wrong.
      if (entry.kind !== "step" || entry.capability !== "edit") continue;

      const leftover = await unfinishedWork(runner, worktreePath);
      if (leftover) {
        keepWorktree = true;
        settle("failed", `${entry.name} left the worktree unclean`);
        await reporter.failed(
          task,
          `${entry.name} left the worktree unclean, so anything after it would judge a tree that is not what was committed:\n\n${leftover}\n\nNothing was pushed; the worktree is kept at \`${worktreePath}\` on the worker host.`
        );
        return;
      }
    }

    // Not checked once the merge landed: gh pr merge deliberately runs without a signal, so a stop
    // pressed during it is only seen afterwards — and releasing there would put a task whose change
    // is already on the base branch back in the queue for another full run.
    if (!state.merged && (await releaseIfAborted(deps, reporter, task, whatLanded(state, branch)))) {
      return;
    }

    // Merged because the sequence carried a Merge step, not because a flag beside it said so.
    // Branching on the pull request url instead would call every merge a delivery: the url is set
    // either way, and only the step knows whether anything was merged.
    if (state.merged) {
      settle("merged");
      await reporter.merged(task, state.prUrl, state.summary);
    } else {
      settle("delivered", state.prUrl);
      await reporter.delivered(task, state.prUrl, state.summary);
    }
  } catch (error) {
    settle("requeued", "the worker hit an unexpected error");
    await reporter.requeued(task, `the worker hit an unexpected error: ${String(error)}`);
  } finally {
    if (!keepWorktree) {
      await quietly(() => workspace.destroy(task.taskKey));
    }
  }
}
