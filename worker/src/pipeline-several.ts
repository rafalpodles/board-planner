import { dirname } from "path";
import { gateCommandsOf, gateConfigFault, usesOwnCommands } from "./gates/gate-commands.js";
import { createBudget } from "./budget.js";
import { commitAll, TamperedCheckoutError } from "./commit.js";
import { branchFor, WORKER_BRANCH_SLUG } from "./decisions.js";
import { Delivery } from "./delivery.js";
import { Runner } from "./exec.js";
import { WorktreeRef } from "./executor.js";
import { WorkerConfig } from "./config.js";
import { ignoredFiles } from "./hidden-files.js";
import {
  EMPTY_RESULT,
  fitDetail,
  gateCapFor,
  hitUsageLimit,
  keptWorktree,
  MIN_ENTRY_MS,
  phaseFor,
  PipelineDeps,
  quietly,
  refuseWorktree,
  releaseIfAborted,
  resolveStatusIds,
  RunDisposition,
  unfinishedWork,
  vetBeforeGate,
  whatLanded,
} from "./pipeline.js";
import { unexpectedHistory } from "./provenance.js";
import { recordFor } from "./run-record.js";
import { scrub } from "./scrub.js";
import { RunState } from "./steps.js";
import { isResultEvent, StreamEvent } from "./stream.js";
import { OutcomeKind } from "./telemetry.js";
import { gitArgs, localGitEnv, requireGitPath } from "./git-safety.js";
import { pinGit } from "./worktree-pin.js";
import { Workspace, Worktree } from "./workspace.js";
import { ClaimedTask, SnapshotEntry } from "./types.js";
import { StepOutcome } from "./steps.js";

/**
 * One repository of a project that lists several, as a run in all of them needs it: where it is
 * (`config.repoPath` and `config.worktreeRoot` are this checkout's own), and the pieces that were
 * built for it.
 */
export interface RepositoryRunDeps {
  /** What the board calls it. Server-supplied, so it is cleaned before it reaches a comment. */
  name: string;
  /** The server's address for it, which is what its visibility is asked of; never the checkout's own config. */
  remote: string;
  config: WorkerConfig;
  workspace: Workspace;
  createDelivery: (runner: Runner, baseBranch?: string) => Delivery;
}

export interface SeveralRepositoriesDeps
  extends Omit<PipelineDeps, "workspace" | "createDelivery" | "quarantineProject"> {
  /** Every repository of the project, the primary first. `config` above is the project's. */
  repositories: RepositoryRunDeps[];
  /**
   * Stops this machine claiming for the project, on the checkout that is the problem. The index is
   * the repository's place in `repositories`, which is what tells the caller which path to name.
   */
  quarantineCheckout: (projectId: string, repositoryIndex: number, reason: string, repair?: string) => void;
}

// What a run keeps for one repository. The state is the single-repository run's own, so the same
// steps, the same commit bookkeeping and the same words describe it.
interface Leg {
  repo: RepositoryRunDeps;
  label: string;
  worktree: Worktree;
  delivery: Delivery;
  state: RunState;
  ignoredBeforeSteps: Awaited<ReturnType<typeof ignoredFiles>>;
}

const GENERIC_SUMMARY =
  "This is one part of a task that changed several repositories. Its description is limited to this repository's own part because not every repository of the task is known to be public.";

const MAX_LABEL = 100;
// A name is member-writable and ends up in a board comment: one line, no backtick to close a span
function labelFor(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, MAX_LABEL) || "repository";
}

type Ending = {
  outcome: OutcomeKind;
  detail?: string;
  reason?: string;
  keep?: boolean;
  report: () => Promise<void>;
  disposition?: RunDisposition;
};

/**
 * One run of one task across every repository of its project: a worktree in each, the agent may write
 * in all of them, and nothing is delivered unless every repository passed.
 *
 * Separate from `runTask` on purpose. That one is the single-repository run, proven over many
 * attempts, and it keeps its own words, outcomes and tests; this one reuses what it can (the failure
 * of a worktree, the vetting before a gate, the commit, the unfinished-work check) and is only
 * reached for a project that lists several repositories.
 *
 * What it holds to, from the review of the plan:
 * - after every write, the tamper, commit-scan, unfinished-work and ignored-file checks run on EVERY
 *   worktree, including the ones the agent did not mean to touch: a confined step can write in all
 *   of them, and a check that skipped one would be a hole in it;
 * - steps run entry by entry across the repositories, never repository by repository, so a gate
 *   failing in the second repository is known before anything of the first is pushed;
 * - nothing is pushed unless every repository's checks passed first, and a refused change is never
 *   pushed at all;
 * - a repository the agent did not change is checked for tampering and then left alone: it gets no
 *   gate, no push and no pull request.
 *
 * Not yet, and said so on the board when it matters: a refused change is not offered for a person's
 * decision (that marker is one worktree), and the review gate reads one repository's diff at a time.
 */
export async function runTaskInRepositories(
  deps: SeveralRepositoriesDeps,
  task: ClaimedTask,
): Promise<RunDisposition> {
  const { config, executor, telemetry } = deps;
  const now = deps.now ?? Date.now;
  const branch = branchFor(task.taskKey);

  const enter = (phase: ReturnType<typeof phaseFor>): void => telemetry?.emit({ phase, taskKey: task.taskKey });

  const startedAt = now();
  let costUsd = 0;
  const settle = (outcome: OutcomeKind, detail?: string, reason?: string): void => {
    telemetry?.emit(
      detail === undefined
        ? { outcome, taskKey: task.taskKey }
        : { outcome, taskKey: task.taskKey, detail: fitDetail(scrub(detail)) },
    );
    deps.recordRun(
      task.projectId,
      recordFor(task, outcome, scrub(detail ?? ""), startedAt, now(), costUsd, reason ? scrub(reason) : undefined),
    );
  };
  const onEvent = (event: StreamEvent): void => {
    if (isResultEvent(event) && typeof event.total_cost_usd === "number") costUsd += event.total_cost_usd;
    telemetry?.emitEvent(event);
  };

  enter("claiming");

  let statusIds;
  try {
    statusIds = await resolveStatusIds(deps.api, deps.boardColumns, task.projectId);
  } catch (error) {
    await quietly(() =>
      deps.api.comment(task.projectId, task.taskId, scrub(`Returned to the queue: ${String(error)}`)),
    );
    await quietly(() => deps.api.release(task.projectId, task.taskId, { refund: false }));
    settle("released", "the board could not route the outcome");
    return;
  }
  const reporter = deps.createReporter(deps.api, statusIds);

  // Every worktree, or none. A failure part of the way destroys what was made and is refused exactly
  // as the single-repository run refuses it, quarantining the checkout that failed.
  const made: { repo: RepositoryRunDeps; worktree: Worktree }[] = [];
  const destroyAll = async (): Promise<void> => {
    for (const repo of deps.repositories) await quietly(() => repo.workspace.destroy(task.taskKey));
  };
  try {
    enter("worktree");
    for (const repo of deps.repositories) {
      made.push({ repo, worktree: await repo.workspace.create(task.taskKey, WORKER_BRANCH_SLUG) });
    }
  } catch (error) {
    const failing = made.length;
    return refuseWorktree(error, {
      task,
      reporter,
      settle,
      destroy: destroyAll,
      quarantine: (reason, repair) => deps.quarantineCheckout(task.projectId, failing, reason, repair),
      logError: deps.logError,
    });
  }

  // One runner holding every pin: each call is made with the worktree it is about as its cwd, which is
  // what selects the git dir it is pinned to (BP-794).
  const runner = pinGit(deps.runner, () => made.map((m) => m.worktree.pin));
  const legs: Leg[] = made.map(({ repo, worktree }) => ({
    repo,
    label: labelFor(repo.name),
    worktree,
    delivery: repo.createDelivery(runner, repo.config.baseBranch),
    state: {
      committed: false,
      uncommittedWork: false,
      commits: [],
      pushed: false,
      prUrl: "",
      merged: false,
      summary: "",
      checks: [],
      lastResult: EMPTY_RESULT,
    },
    ignoredBeforeSteps: { kind: "listed", files: new Map<string, string>() },
  }));

  let keepWorktrees = false;
  const where = (): string =>
    legs.map((leg) => `${leg.label}: \`${leg.worktree.path}\``).join("; ");
  const kept = (): string => `\n\nThe worktrees are kept on the worker host, with what this run wrote: ${where()}`;
  const landed = (): string =>
    legs
      .map((leg) => whatLanded(leg.state, branch).replace(/^: /, ""))
      .map((text, index) => (text ? `${legs[index].label} ${text}` : ""))
      .filter(Boolean)
      .map((text, index) => (index === 0 ? `: ${text}` : text))
      .join("; ");
  const unpushed = (): string => {
    const stuck = legs.filter((leg) => leg.state.committed && !leg.state.pushed);
    return stuck.length
      ? `\n\nWhat the run committed in ${stuck.map((leg) => leg.label).join(", ")} is not pushed${kept()}`
      : "";
  };
  const end = async (ending: Ending): Promise<RunDisposition> => {
    if (ending.keep) keepWorktrees = true;
    settle(ending.outcome, ending.detail, ending.reason);
    await ending.report();
    return ending.disposition;
  };

  // Whatever the agent could write in any worktree, in any of them: asked of all, every time
  const tamperingAnywhere = async (): Promise<string | null> => {
    for (const leg of legs) {
      const tampered = await leg.worktree.tampering();
      if (tampered) return `${leg.label}: ${tampered}`;
    }
    return null;
  };

  const budget = createBudget(config.runCeilingMs, now);
  const onOwnCommands = usesOwnCommands(gateCommandsOf(config));

  try {
    for (const leg of legs) leg.ignoredBeforeSteps = await ignoredFiles(runner, deps.gitPath, leg.worktree.path);
    const anyMerged = (): boolean => legs.some((leg) => leg.state.merged);

    // Every repository or none: a gate runs only where the agent changes something, so a `./gradlew` one
    // of them lacks says nothing about this task
    const configFaults = legs.map((leg) => gateConfigFault(task.agent.sequence, gateCommandsOf(config), leg.worktree.path));
    const configFault = configFaults.every(Boolean) ? configFaults[0] : null;
    if (configFault) {
      settle("failed", configFault);
      await reporter.failed(task, `this run stopped before any step: ${configFault}`);
      return "settings-fault";
    }

    for (const [position, entry] of task.agent.sequence.entries()) {
      if (await releaseIfAborted(deps, reporter, task, landed())) return;

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
        const outcome = entry.deterministic
          ? await deliver(entry)
          : await modelStep(entry, position);

        if (outcome.kind !== "ok" && legs.some((leg) => leg.state.committed || leg.state.uncommittedWork)) {
          keepWorktrees = true;
        }
        if (!anyMerged() && (await releaseIfAborted(deps, reporter, task, landed()))) return;

        const ended = await settleStep(outcome, entry);
        if (ended !== undefined) return ended.disposition;
      } else {
        const ended = await gateEntry(entry);
        if (ended !== undefined) return ended.disposition;
      }

      // After every step that could write, and in every worktree: an unclean tree poisons everything
      // after it, and the agent could have written in any of them
      if (entry.kind !== "step" || entry.capability !== "edit") continue;
      for (const leg of legs) {
        const leftover = await unfinishedWork(runner, deps.gitPath, leg.worktree.path, leg.worktree.baseSha, onOwnCommands ? leg.ignoredBeforeSteps : undefined);
        if (leftover) {
          return (
            await end({
              outcome: "failed",
              detail: `${entry.name} left a worktree unclean`,
              keep: true,
              report: () =>
                reporter.failed(
                  task,
                  `${entry.name} left the ${leg.label} worktree unclean, so anything after it would judge a tree that is not what was committed:\n\n${leftover}\n\nNothing was pushed${kept()}`,
                ),
            })
          );
        }
      }
    }

    if (!anyMerged() && (await releaseIfAborted(deps, reporter, task, landed()))) return;

    const delivered = legs.filter((leg) => leg.state.prUrl);
    const urls = delivered.map((leg) => leg.state.prUrl).join(", ");
    const summary = legs.find((leg) => leg.state.summary)?.state.summary ?? "";
    if (delivered.length > 0 && delivered.every((leg) => leg.state.merged)) {
      settle("merged");
      await reporter.merged(task, urls, summary);
    } else {
      settle("delivered", urls);
      await reporter.delivered(task, urls, summary);
    }
  } catch (error) {
    const keeping = legs.some((leg) => leg.state.committed || leg.state.uncommittedWork);
    if (keeping) keepWorktrees = true;
    settle("requeued", "the worker hit an unexpected error");
    await reporter.requeued(
      task,
      `the worker hit an unexpected error: ${String(error)}${keeping ? keptWorktree(where()) : ""}`,
    );
  } finally {
    if (!keepWorktrees) await destroyAll();
  }

  // A step the agent runs in every worktree at once: confined to all of them, told where each is
  async function modelStep(entry: SnapshotEntry, position: number): Promise<StepOutcome> {
    const tampered = await tamperingAnywhere();
    if (tampered) {
      return { kind: "tampered", finding: tampered, message: `refusing to run ${entry.name}: the checkout now has ${tampered}` };
    }
    const repositories: WorktreeRef[] = legs.map((leg) => ({
      name: leg.label,
      path: leg.worktree.path,
      dir: leg.worktree.dir,
    }));
    const sequence = task.agent.sequence;
    const later = sequence
      .slice(position + 1)
      .filter((next) => next.kind === "gate")
      .map((next) => next.gateKind ?? "");

    const outcome = await executor.execute({
      task,
      worktreePath: legs[0].worktree.path,
      worktreeDir: legs[0].worktree.dir,
      repositories,
      checkoutGitDirs: legs.map((leg) => dirname(dirname(leg.worktree.pin.gitDir))),
      signal: deps.signal,
      onEvent,
      brief: {
        provider: entry.provider,
        prompt: entry.prompt ?? "",
        capability: entry.capability ?? "read-only",
        model: entry.model ?? "",
        fallbackModel: entry.fallbackModel ?? "",
        timeoutMs: budget.forEntry(config.taskTimeoutMs),
        laterChecks: later,
      },
    });

    if (outcome.kind === "usage_limit") return { kind: "usage_limit" };
    if (outcome.kind === "timeout") return { kind: "timeout" };
    if (outcome.kind === "machine_fault") return { kind: "machine_fault", message: outcome.message };
    if (outcome.kind === "tampered") {
      return { kind: "tampered", finding: outcome.finding, message: `refusing to run ${entry.name}: the checkout now has ${outcome.finding}` };
    }
    if (outcome.kind === "error") return { kind: "error", message: outcome.message };
    if (outcome.result.status === "blocked") return { kind: "blocked", reason: outcome.result.blockedReason };

    for (const leg of legs) {
      leg.state.summary = outcome.result.summary || leg.state.summary;
      leg.state.lastResult = outcome.result;
    }

    if (entry.capability === "edit") {
      // Every repository is committed, or the step fails: what the agent wrote is in the trees and in
      // no history until each commit has happened
      const changed: Leg[] = [];
      for (const leg of legs) {
        try {
          const tamperedNow = await leg.worktree.tampering();
          if (tamperedNow) throw new TamperedCheckoutError(tamperedNow);
          const sha = await commitAll(
            runner,
            deps.gitPath,
            leg.worktree.path,
            `${task.taskKey}: ${entry.name.toLowerCase()}`,
            leg.worktree.commitIdentity,
            leg.worktree.baseSha,
            onOwnCommands ? leg.ignoredBeforeSteps : undefined,
          );
          if (sha) {
            leg.state.commits.push(sha);
            leg.state.checks.splice(0);
            changed.push(leg);
          }
          leg.state.committed = leg.state.committed || sha !== "";
        } catch (error) {
          for (const each of legs) each.state.uncommittedWork = true;
          if (error instanceof TamperedCheckoutError) {
            return { kind: "tampered", finding: error.finding, message: `${leg.label}: ${error.message}` };
          }
          return { kind: "error", message: `${leg.label}: ${String(error)}` };
        }
      }
      // After every commit has happened, so that what throws here cannot read as one having failed
      if (onOwnCommands) {
        for (const leg of changed) {
          try {
            leg.worktree.emptyGateHome();
          } catch (error) {
            return { kind: "error", message: `${leg.label}: ${String(error)}` };
          }
        }
      }
    }
    return { kind: "ok" };
  }

  // The worker's own steps. Each looks at every repository first and acts after, so a refusal in the
  // last one leaves the first untouched.
  async function deliver(entry: SnapshotEntry): Promise<StepOutcome> {
    try {
      const active = legs.filter((leg) => leg.state.committed);
      const tampered = await tamperingAnywhere();
      if (tampered) {
        const act = entry.key === "pull-request" ? "open a pull request" : entry.key;
        return { kind: "error", message: `refusing to ${act}: the checkout now has ${tampered}` };
      }

      switch (entry.key) {
        case "push": {
          if (active.length === 0) return { kind: "error", message: "refusing to push: the agent changed no repository" };
          const refusals: string[] = [];
          for (const leg of active) {
            const wrong = await unexpectedHistory(runner, deps.gitPath, leg.worktree.path, leg.worktree.baseSha, leg.state.commits);
            if (wrong) refusals.push(`${leg.label}: ${wrong}`);
          }
          if (refusals.length > 0) {
            return { kind: "error", message: `refusing to push anything: ${refusals.join("; ")}` };
          }
          for (const leg of active) {
            try {
              await leg.delivery.push(leg.worktree.path, branch, leg.state.commits[leg.state.commits.length - 1] ?? "");
            } catch (error) {
              return { kind: "error", message: `${leg.label}: ${String(error)}` };
            }
            leg.state.pushed = true;
          }
          return { kind: "ok" };
        }

        case "pull-request": {
          if (active.length === 0) return { kind: "error", message: "refusing to open a pull request: the agent changed no repository" };
          const privacy = await visibilityOf();
          for (const leg of active) {
            // The agent writes one summary about all of its work, and it has read every repository of
            // the run, whether or not it changed one. A description is as public as its repository, so
            // one that is not known to be private carries the summary only when every other repository
            // of the run is known to be public: otherwise there may be prose about a private one in it.
            const mayCarryProse = privacy.get(leg) === true || legs.every((other) => other === leg || privacy.get(other) === false);
            const summary = mayCarryProse ? leg.state.summary : GENERIC_SUMMARY;
            try {
              leg.state.prUrl = await leg.delivery.openPr(leg.worktree.path, task, summary, leg.state.checks);
            } catch (error) {
              return { kind: "error", message: `${leg.label}: ${String(error)}` };
            }
          }
          await listRelated(active, privacy);
          return { kind: "ok" };
        }

        case "merge": {
          const open = active.filter((leg) => leg.state.prUrl);
          if (open.length === 0) {
            return { kind: "error", message: "the merge step ran with no pull request to merge" };
          }
          for (const leg of open) {
            try {
              await leg.delivery.merge(leg.worktree.path, leg.state.prUrl);
            } catch (error) {
              const done = open.filter((each) => each.state.merged).map((each) => each.label);
              const left = open.filter((each) => !each.state.merged).map((each) => each.label);
              return {
                kind: "error",
                message: `${leg.label}: ${String(error)}\n\nMerged: ${done.join(", ") || "none"}. Not merged: ${left.join(", ")}. Merging stopped at the first refusal and nothing was rolled back.`,
              };
            }
            leg.state.merged = true;
          }
          return { kind: "ok" };
        }

        default:
          return { kind: "error", message: `this worker implements no action named ${entry.key}` };
      }
    } catch (error) {
      return { kind: "error", message: String(error) };
    }
  }

  // Asked of every repository of the run, the unchanged ones included, and before any pull request
  // exists. The remote is the one the server named and this machine reported; the pull request goes
  // where the checkout's origin is NOW, so a verdict is used only while the two are still the same
  // address.
  async function visibilityOf(): Promise<Map<Leg, boolean | null>> {
    const answers = await Promise.all(
      legs.map(async (leg): Promise<boolean | null> => {
        try {
          if ((await liveOrigin(leg)) !== leg.repo.remote) return null;
          return await leg.delivery.isPrivate(leg.worktree.path, leg.repo.remote);
        } catch {
          return null;
        }
      }),
    );
    return new Map(legs.map((leg, index) => [leg, answers[index]]));
  }

  async function liveOrigin(leg: Leg): Promise<string | null> {
    const result = await runner.run(requireGitPath(deps.gitPath), gitArgs(["remote", "get-url", "origin"]), {
      cwd: leg.worktree.path,
      timeoutMs: 30_000,
      env: localGitEnv(),
    });
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : null;
  }

  // Each pull request lists the others, unless that would put a repository that is not known to be
  // public into the description of one that is not known to be private: the description of a public
  // pull request is public.
  async function listRelated(active: Leg[], privacy: Map<Leg, boolean | null>): Promise<void> {
    if (active.length < 2) return;
    for (const leg of active) {
      const related = active
        .filter((other) => other !== leg && (privacy.get(leg) === true || privacy.get(other) === false))
        .map((other) => other.state.prUrl);
      if (related.length === 0) continue;
      try {
        await leg.delivery.linkRelated(leg.worktree.path, leg.state.prUrl, related);
      } catch (error) {
        await quietly(() =>
          reporter.noted(task, `Could not list the other pull requests in ${leg.state.prUrl}: ${String(error)}`),
        );
      }
    }
  }

  async function settleStep(outcome: StepOutcome, entry: SnapshotEntry): Promise<Ending | undefined> {
    if (outcome.kind === "ok") return undefined;
    const done = async (ending: Ending): Promise<Ending> => {
      await end(ending);
      return ending;
    };
    if (outcome.kind === "usage_limit") {
      return done({ outcome: "released", detail: "usage limit reached", report: () => reporter.released(task, `usage limit reached${unpushed()}`) });
    }
    if (outcome.kind === "machine_fault") {
      return done({
        outcome: "machineFault",
        detail: outcome.message,
        disposition: "machine-fault",
        report: () => reporter.released(task, `${outcome.message}${unpushed()}`),
      });
    }
    if (outcome.kind === "timeout") {
      return done({ outcome: "requeued", detail: `${entry.name} timed out`, report: () => reporter.requeued(task, `${entry.name} timed out`) });
    }
    if (outcome.kind === "blocked") {
      return done({ outcome: "blocked", detail: outcome.reason, report: () => reporter.blocked(task, `${outcome.reason}${unpushed()}`) });
    }
    if (outcome.kind === "tampered") {
      return done({
        outcome: "failed",
        detail: outcome.message,
        keep: true,
        report: () => reporter.failed(task, `${outcome.message}\n\nNothing was pushed by this step${kept()}`),
      });
    }
    // error
    if (entry.deterministic) {
      return done({
        outcome: "failed",
        detail: outcome.message,
        keep: true,
        report: () => reporter.failed(task, `${entry.name} failed${landed()}: ${outcome.message}${kept()}`),
      });
    }
    return done({
      outcome: "requeued",
      detail: outcome.message,
      report: () =>
        reporter.requeued(
          task,
          `${entry.name} failed: ${outcome.message}${legs.some((leg) => leg.state.committed || leg.state.uncommittedWork) ? kept() : ""}`,
        ),
    });
  }

  async function gateEntry(entry: SnapshotEntry): Promise<Ending | undefined> {
    const done = async (ending: Ending): Promise<Ending> => {
      await end(ending);
      return ending;
    };
    const gateOptions = {
      maxDiffLines: config.maxDiffLines,
      maxDiffFiles: config.maxDiffFiles,
      reviewModel: config.reviewModel ?? "",
    };
    const gate = deps.gateFor(entry, runner, budget.forEntry(gateCapFor(config)), gateOptions);
    if (!gate) {
      return done({
        outcome: "failed",
        detail: `no gate named ${entry.key}`,
        keep: true,
        report: () =>
          reporter.failed(
            task,
            `this worker implements no gate of kind ${JSON.stringify(entry.gateKind ?? "")} (${entry.key}), so the agent could not be run as it was composed. Nothing was pushed${kept()}`,
          ),
      });
    }

    // Every worktree is vetted, the ones with nothing committed too: the gate is about to run code
    // somewhere, and the agent could have written anywhere it was confined to
    for (const leg of legs) {
      const refused = await vetBeforeGate(
        runner,
        deps.gitPath,
        leg.worktree,
        leg.ignoredBeforeSteps,
        gate.name,
        (note) => reporter.noted(task, `${leg.label}: ${note}`),
        onOwnCommands ? leg.ignoredBeforeSteps : undefined,
      );
      if (refused) {
        return done({
          outcome: "failed",
          detail: `refused to run the ${gate.name} gate over ${refused.over}`,
          keep: true,
          report: () =>
            reporter.failed(
              task,
              `refusing to run the ${gate.name} gate over the ${leg.label} worktree: ${refused.detail}\n\nNothing was pushed${kept()}`,
            ),
        });
      }
    }

    const active = legs.filter((leg) => leg.state.committed);
    if (active.length === 0) {
      return done({
        outcome: "gateRejected",
        detail: gate.name,
        reason: "the agent changed no repository",
        keep: true,
        report: () =>
          reporter.gateRejected(
            task,
            gate.name,
            `the agent changed no repository, so there is nothing for this gate to check.\n\n**Nothing was pushed.**${kept()}`,
            "",
          ),
      });
    }

    for (const [index, leg] of active.entries()) {
      // A gate takes its time limit when it is made, so one shared by every repository would give
      // each of them the whole of what was left
      if (index > 0 && (budget.exhausted() || budget.remaining() < MIN_ENTRY_MS)) {
        return done({
          outcome: "requeued",
          detail: "the run hit its ceiling",
          keep: true,
          report: () =>
            reporter.requeued(
              task,
              `the run hit its ceiling of ${config.runCeilingMs}ms before the ${gate.name} gate reached ${leg.label}. Nothing was pushed, in any repository${kept()}`,
            ),
        });
      }
      const legGate = index === 0 ? gate : (deps.gateFor(entry, runner, budget.forEntry(gateCapFor(config)), gateOptions) ?? gate);
      const diff = await deps.collectDiff(runner, leg.worktree.path, leg.worktree.baseSha);
      const startedGate = now();
      const verdict = await legGate.run({
        worktreePath: leg.worktree.path,
        worktreeDir: leg.worktree.dir,
        gateHome: leg.worktree.gateHome,
        checkoutGitDir: dirname(dirname(leg.worktree.pin.gitDir)),
        task,
        result: leg.state.lastResult,
        diff,
        signal: deps.signal,
      });
      if (await releaseIfAborted(deps, reporter, task)) return { outcome: "released", report: async () => {}, disposition: undefined };
      if (verdict.ok) {
        leg.ignoredBeforeSteps = await ignoredFiles(runner, deps.gitPath, leg.worktree.path);
        leg.state.checks.push({
          name: gate.name,
          commands: verdict.commands ?? [],
          durationMs: Math.max(0, now() - startedGate),
        });
        continue;
      }

      if (verdict.tampered) {
        const message = `refusing to run the ${gate.name} gate: the ${leg.label} checkout now has ${verdict.tampered}`;
        return done({ outcome: "failed", detail: message, keep: true, report: () => reporter.failed(task, `${message}\n\nNothing was pushed${kept()}`) });
      }
      if (verdict.machineFault) {
        return done({
          outcome: "machineFault",
          detail: `the ${gate.name} gate could not run: ${verdict.reason}`,
          keep: true,
          disposition: "machine-fault",
          report: () => reporter.released(task, `the ${gate.name} gate could not run in ${leg.label}: ${verdict.reason}${unpushed()}`),
        });
      }
      if (hitUsageLimit(verdict)) {
        return done({
          outcome: "released",
          detail: `the ${gate.name} gate could not run`,
          report: () => reporter.released(task, `the ${gate.name} gate could not run: ${verdict.reason}`),
        });
      }

      // Refused: nothing is pushed in any repository. A branch carrying what a gate refused is not
      // offered for a person's decision here yet, since that marker is one worktree; the change is in
      // the worktrees, and the patch is in this comment.
      const repeats = task.previousRejectionReason !== "" && verdict.reason === task.previousRejectionReason;
      const reason = repeats
        ? `A previous attempt at this task was already rejected for this same reason, which was in this attempt's brief — it made no difference:\n\n${verdict.reason}`
        : verdict.reason;
      return done({
        outcome: "gateRejected",
        detail: gate.name,
        reason: verdict.reason,
        keep: true,
        report: () =>
          reporter.gateRejected(
            task,
            gate.name,
            `In ${leg.label}: ${reason}\n\n**Nothing was pushed, in any repository**, on purpose: a run that spans several repositories delivers all of them or none. The work is in the worktrees on the worker host: ${where()}`,
            "",
            diff.patch,
          ),
      });
    }
    return undefined;
  }
}
