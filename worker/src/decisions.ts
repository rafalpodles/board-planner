import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { ApiClient, DecisionSettlement } from "./api.js";
import { Delivery } from "./delivery.js";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";
import { protectedPaths, workflowPaths } from "./gates/protected-paths.js";
import { ClaimedTask, DiffStats } from "./types.js";

/**
 * What this machine has to remember about a refused change while a person reads it.
 *
 * It exists for the reaper. A worktree under the worker's own root belongs to a run that died with
 * its process, and `reapOrphans` destroys it on the next pass — which for a decision is the whole
 * point of the worktree, deleted. So the run leaves a note beside it.
 *
 * The note also carries what the settlement needs and the server deliberately does not store:
 * `baseSha`, so the patch can be re-derived and compared, and `commit`, so a record naming some
 * other commit is refused before anything is pushed. Both are this machine's own record of what it
 * did, written before the server was told anything.
 */
export interface DecisionMarker {
  taskKey: string;
  /** Which worktree root this belongs to: two projects sharing a checkout share a root. */
  worktreeRoot: string;
  worktreePath: string;
  projectId: string;
  taskId: string;
  commit: string;
  baseSha: string;
  createdAt: string;
  /**
   * How many times this machine has tried to act on a verdict, counted HERE rather than read off
   * the record.
   *
   * The record's own `attempts` only advances when a settlement lands — so it counts the passes
   * that reported something, and not the passes where the board would not take the report. Those
   * are exactly the runaway: each one spends `collectDiff`, a push and a `gh pr create` on the
   * owner's pinned token before discovering the settle failed, and the counter it was bounded by
   * never moved. A count on this machine's own disk is independent of the channel that is failing,
   * and survives a restart where an in-memory one would not.
   */
  attempts?: number;
  /** When the last of those was, so the retries can be spaced rather than merely counted. */
  lastAttemptAt?: string;
}

export interface MarkerStore {
  write(marker: DecisionMarker): void;
  read(taskKey: string): DecisionMarker | null;
  remove(taskKey: string): void;
  list(): DecisionMarker[];
}

/** The same shape `api.ts` refuses a task key on: this one becomes a file name. */
const SAFE_TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*-\d+$/;

export function isSafeTaskKey(taskKey: string): boolean {
  return SAFE_TASK_KEY.test(taskKey);
}

/** Just enough of `node:fs` to be replaced in a test. */
export interface MarkerFs {
  mkdir(path: string): void;
  writeFile(path: string, text: string): void;
  readFile(path: string): string | null;
  remove(path: string): void;
  listNames(path: string): string[];
}

export const nodeMarkerFs: MarkerFs = {
  // 0o700 and 0o600 for the reason every other state file here carries them: the directory sits
  // beside the worker's credential, and its contents name paths on this machine.
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  remove: (path) => rmSync(path, { force: true }),
  listNames: (path) => (existsSync(path) ? readdirSync(path) : []),
};

function parse(text: string | null): DecisionMarker | null {
  if (!text) return null;
  try {
    const marker = JSON.parse(text) as DecisionMarker;
    return marker?.taskKey && marker.worktreeRoot ? marker : null;
  } catch {
    return null;
  }
}

export function createMarkerStore(stateDir: string, fs: MarkerFs = nodeMarkerFs): MarkerStore {
  const dir = join(stateDir, "decisions");
  // Refused rather than sanitised, same as api.ts: a key this worker cannot name safely is one it
  // must not write under some other name nobody chose.
  const pathFor = (taskKey: string): string => {
    if (!isSafeTaskKey(taskKey)) {
      throw new Error(`refusing decision marker for task key ${JSON.stringify(taskKey)}`);
    }
    return join(dir, `${taskKey}.json`);
  };

  return {
    write(marker) {
      const path = pathFor(marker.taskKey);
      fs.mkdir(dir);
      fs.writeFile(path, JSON.stringify(marker));
    },
    read(taskKey) {
      return parse(fs.readFile(pathFor(taskKey)));
    },
    remove(taskKey) {
      fs.remove(pathFor(taskKey));
    },
    list() {
      return fs
        .listNames(dir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const marker = parse(fs.readFile(join(dir, name)));
          return marker ? [marker] : [];
        });
    },
  };
}

/**
 * The worktrees under this root that a decision is holding, by task key.
 *
 * Keyed on the root rather than on the project because `rebind` resolves several projects onto one
 * checkout, and a root is shared by all of them — a marker filtered by project would let a sibling
 * project's reaping pass destroy a worktree somebody is being asked about.
 */
export function heldTaskKeys(store: Pick<MarkerStore, "list">, worktreeRoot: string): Set<string> {
  const root = resolve(worktreeRoot);
  return new Set(
    store
      .list()
      .filter((marker) => resolve(marker.worktreeRoot) === root)
      .map((marker) => marker.taskKey)
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Where a task's worktree is, by the one rule every assignment follows: the machine resolves it. */
export function worktreePathFor(worktreeRoot: string, taskKey: string): string {
  const root = resolve(worktreeRoot);
  const path = resolve(root, taskKey);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing task key ${JSON.stringify(taskKey)}: its path falls outside ${root}`);
  }
  return path;
}

/**
 * Whether accepting is on offer at all, and the sentence that says why not.
 *
 * Two refusals, and they are different in kind. A workflow file is the one family excluded on
 * purpose — see WORKFLOW_FILE. A truncated patch is excluded because the record IS the reading
 * surface: `collectDiff` bounds the patch, and a change too large to show is one nobody can
 * honestly accept. The first draft of this design never consulted `truncated` at all.
 */
/** A few paths and a count, so a long list cannot eat the sentence it sits in. */
function nameAFew(paths: string[], keep = 3): string {
  if (paths.length <= keep) return paths.join(", ");
  return `${paths.slice(0, keep).join(", ")} and ${paths.length - keep} more`;
}

export function acceptability(
  diff: Pick<DiffStats, "changedFiles" | "truncated" | "suppressedDiffs">
): {
  acceptable: boolean;
  unacceptableReason: string;
} {
  const workflows = workflowPaths(diff.changedFiles);
  if (workflows.length > 0) {
    return {
      acceptable: false,
      unacceptableReason:
        `the change edits what CI itself does (${workflows.join(", ")}). For a push event GitHub ` +
        `runs the workflow from the pushed ref, so accepting would run the agent's own version of ` +
        `it — and a workflow diff is the hardest thing on this list to read for safety. This one ` +
        `is a person's own commit to make.`,
    };
  }
  if (diff.truncated) {
    return {
      acceptable: false,
      unacceptableReason:
        "the change is larger than the patch this record can carry, so what is shown below is not " +
        "all of it. Nobody can accept a change they have not been shown.",
    };
  }
  // The same rule as above, arrived at from the patch rather than from its size: git has declined
  // to show these files, so the diff below has holes in it. Three causes and a genuine binary all
  // look identical from here, which is the point — what matters is that the file is listed as
  // changed and its contents are not there.
  if (diff.suppressedDiffs.length > 0) {
    return {
      acceptable: false,
      // Named, then counted. The server bounds this reason at 500 characters, and the preamble
      // alone is most of 200 — so an unbounded list would be cut mid-path and take the sentence
      // that explains the missing button with it.
      unacceptableReason:
        `git does not show what changed in ${nameAFew(diff.suppressedDiffs)} — the patch below ` +
        "lists it and not its contents, whether because it is binary, because something in the " +
        "repository says not to show it, or because it is a submodule whose whole diff is two " +
        "object ids. Nobody can accept a change they have not been shown.",
    };
  }
  return { acceptable: true, unacceptableReason: "" };
}

export interface OpenDecisionDeps {
  markers: MarkerStore;
  api: Pick<ApiClient, "createDecision">;
  /** The same redaction every agent-authored string reaching the board goes through. */
  scrub: (text: string) => string;
}

export interface OpenDecisionInput {
  task: ClaimedTask;
  gate: string;
  diff: DiffStats;
  worktreePath: string;
  worktreeRoot: string;
  baseSha: string;
}

/**
 * Offer a refused change to a person.
 *
 * The marker goes first, and a marker that cannot be written aborts the whole thing: a button over
 * a worktree the reaper is free to destroy is worse than no button. If the record itself cannot be
 * posted the marker is taken back, so a failed offer does not pin a worktree for ever.
 *
 * The digest is taken over the patch as git printed it, not over the redacted copy stored beside
 * it: the machine re-derives the former at settle time, and redaction is not reproducible from the
 * board's side.
 */
export async function openDecision(
  deps: OpenDecisionDeps,
  input: OpenDecisionInput
): Promise<void> {
  const { acceptable, unacceptableReason } = acceptability(input.diff);

  deps.markers.write({
    taskKey: input.task.taskKey,
    worktreeRoot: input.worktreeRoot,
    worktreePath: input.worktreePath,
    projectId: input.task.projectId,
    taskId: input.task.taskId,
    // `headSha`, not the last commit the run made: `collectDiff` resolved it with
    // `rev-parse --verify HEAD^{commit}` and judged the change against it, so this is the one
    // value for which "the commit named in the record is the change that was judged" is true.
    commit: input.diff.headSha,
    baseSha: input.baseSha,
    createdAt: new Date().toISOString(),
  });

  try {
    await deps.api.createDecision({
      taskId: input.task.taskId,
      runId: input.task.runId,
      gate: input.gate,
      // The whole change, not the gate's hits: accepting pushes the commit, all of it. The hits
      // travel separately so the panel can say which of them is the reason this is here.
      files: input.diff.changedFiles,
      fileCount: input.diff.changedFiles.length,
      protectedFiles: protectedPaths(input.diff.changedFiles),
      patch: deps.scrub(input.diff.patch),
      patchTruncated: input.diff.truncated,
      patchSha256: sha256(input.diff.patch),
      commit: input.diff.headSha,
      taskKey: input.task.taskKey,
      title: input.task.title,
      acceptable,
      unacceptableReason,
    });
  } catch (error) {
    deps.markers.remove(input.task.taskKey);
    throw error;
  }
}

/**
 * The branch a run puts its work on. Recomputed here rather than stored on the record and sent
 * back: a server-supplied string reaching `git push` is a force-push to the default branch waiting
 * to happen, and this is derived from a task key `api.ts` has already refused to accept unless it
 * is a name.
 */
export const WORKER_BRANCH_SLUG = "worker";

export function branchFor(taskKey: string): string {
  return `${taskKey.toLowerCase()}/${WORKER_BRANCH_SLUG}`;
}

/** One row of what the server says is waiting on this machine. */
export interface ServerDecision {
  taskId: string;
  projectId: string;
  taskKey: string;
  commit: string;
  patchSha256: string;
  state: string;
  /** The task's own title, so the pull request this opens is named like any other. */
  title: string;
  attempts?: number;
}

/** Everything that only exists relative to a bound checkout, resolved per project. */
export interface DecisionContext {
  worktreeRoot: string;
  destroyWorktree: (taskKey: string) => Promise<void>;
  delivery: Pick<Delivery, "push" | "openPr">;
  runner: Runner;
  collectDiff: (runner: Runner, worktreePath: string, baseSha: string) => Promise<DiffStats>;
}

export interface SettleDecisionsDeps {
  markers: MarkerStore;
  /** Null when this project is no longer bound here, which is what a lost assignment looks like. */
  contextFor: (projectId: string) => Promise<DecisionContext | null>;
  /**
   * Report the outcome. **False means the server did not take it**, and every caller below acts on
   * that rather than assuming it landed.
   *
   * Deliberately NOT routed through the outbox, unlike every other report this worker makes, and
   * the difference is the reason. An outbox entry is retried until it succeeds or twenty attempts
   * run out, and it blocks everything queued behind it in the meantime. A decision settlement can
   * be *permanently* invalid — `superseded` by a second claim, `abandoned` by a person, or simply
   * overtaken — and a 409 that can never succeed would hold every comment, status move and run
   * record on this machine for twenty polls.
   *
   * Worse, a queued settlement is invisible to the pass that queued it: with `delivered` sitting
   * in the outbox the worktree was destroyed, the marker dropped, and the NEXT pass — seeing the
   * server still say `accepted` and no marker — settled `refused` ("this machine no longer holds a
   * worktree"), which landed first and made the real `delivered` a permanent 409. The result was
   * an open pull request the board never named.
   *
   * Retrying the whole settlement next pass is what replaces it. The push is idempotent — the same
   * commit to the same branch is "Everything up-to-date", and `openPr` returns the pull request
   * that already exists — and the retry stops on its own, because a settled decision leaves the
   * list the server sends.
   */
  settle: (settlement: DecisionSettlement) => Promise<boolean>;
  log: (message: string) => void;
}

const GIT_TIMEOUT_MS = 60_000;

/** How long a settled decision's marker keeps holding a worktree on a project nobody serves. */
const UNBOUND_MARKER_TTL_DAYS = 7;
const UNBOUND_MARKER_TTL_MS = UNBOUND_MARKER_TTL_DAYS * 24 * 60 * 60_000;

/**
 * How many times a machine will act on one acceptance before it stops and says so.
 *
 * Dropping the outbox took away a ceiling as well as a hazard. An accepted decision that keeps
 * failing is retried WHOLE every poll — `collectDiff`, a push, and a `gh pr create` — and the
 * server's state does not change, so nothing ends it. Above this the record is settled `failed`
 * with the count in the reason and left for a person, who can accept it again once they have
 * looked. The same shape `MAX_EXECUTION_ATTEMPTS` gives a run.
 */
const MAX_SETTLEMENT_ATTEMPTS = 5;

/**
 * How long before the next try, doubling.
 *
 * Five attempts against a thirty-second refresh floor is a two-and-a-half-minute budget, which an
 * ordinary redeploy eats whole — and then the record says a machine gave up when what actually
 * happened is that the board restarted. Spaced, the ceiling means "this has been failing for half
 * an hour" rather than "the board was busy".
 */
const SETTLE_BACKOFF_MS = 60_000;
const MAX_SETTLE_BACKOFF_MS = 15 * 60_000;

/** One more try, at this machine's clock — the same clock `readyToRetry` measures the wait on. */
function spent(marker: DecisionMarker, tried: number, now: () => number): DecisionMarker {
  return { ...marker, attempts: tried + 1, lastAttemptAt: new Date(now()).toISOString() };
}

function readyToRetry(marker: DecisionMarker | null, now: number): boolean {
  const attempts = marker?.attempts ?? 0;
  if (attempts === 0 || !marker?.lastAttemptAt) return true;
  const wait = Math.min(SETTLE_BACKOFF_MS * 2 ** (attempts - 1), MAX_SETTLE_BACKOFF_MS);
  return now - Date.parse(marker.lastAttemptAt) >= wait;
}

const PR_BODY = [
  "The protected-paths gate refused this change, and a person read it and accepted the push.",
  "",
  "Accepting is not merging: this pull request is reviewed like any other.",
].join("\n");

/**
 * Why the push did not happen, or null when nothing is wrong.
 *
 * `rev-parse --verify refs/heads/<branch>` rather than `rev-parse HEAD`: `git push -- <branch>`
 * resolves the branch in the ref store the linked worktree SHARES with the main clone, so what
 * HEAD happens to be in this directory is not what would be sent.
 */
async function whyNotPushable(
  context: DecisionContext,
  marker: DecisionMarker,
  decision: ServerDecision
): Promise<string | null> {
  if (marker.commit !== decision.commit) {
    return `this machine holds ${marker.commit} for ${decision.taskKey}, not the accepted ${decision.commit}`;
  }

  const branch = branchFor(decision.taskKey);
  const head = await context.runner.run(
    "git",
    gitArgs(["rev-parse", "--verify", `refs/heads/${branch}`]),
    {
      cwd: marker.worktreePath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV },
    }
  );
  if (head.code !== 0) {
    return `\`${branch}\` is not a branch on this machine any more (${head.stderr || head.stdout})`;
  }
  if (head.stdout.trim() !== decision.commit) {
    return `\`${branch}\` is at ${head.stdout.trim()}, not at the accepted ${decision.commit}`;
  }

  // Re-derived rather than trusted: the digest is over the patch git printed at refusal time, and
  // a repository-local textconv or external diff driver planted since then would render the same
  // commit as something else entirely — which is the change a person would NOT have accepted.
  const diff = await context.collectDiff(context.runner, marker.worktreePath, marker.baseSha);
  if (sha256(diff.patch) !== decision.patchSha256) {
    return "the change in the worktree no longer matches the patch that was accepted";
  }

  return null;
}

/**
 * Act on every verdict the server has for this machine, and tidy up after the ones that ended some
 * other way.
 *
 * Drained from `drain()`, which runs even while the worker is paused: pause stops a machine taking
 * NEW work, and has never stopped it finishing work it already holds.
 *
 * There is deliberately no clean-tree precondition. Pushing a named commit makes the working
 * tree's state irrelevant, and demanding a clean one would inherit a false positive the pipeline
 * goes out of its way to avoid.
 */
export async function settleDecisions(
  deps: SettleDecisionsDeps,
  decisions: ServerDecision[],
  /** When the list was fetched, so a marker written after it is not mistaken for an orphan. */
  decisionsAsOf: number,
  /** Injected only so a test can move the retry clock; the pass itself reads the wall clock. */
  now: () => number = Date.now
): Promise<void> {
  for (const decision of decisions) {
    if (decision.state !== "accepted" && decision.state !== "declined") continue;
    if (!isSafeTaskKey(decision.taskKey)) {
      deps.log(`refusing decision for task key ${JSON.stringify(decision.taskKey)}`);
      continue;
    }

    const context = await deps.contextFor(decision.projectId);
    if (!context) continue;

    const marker = deps.markers.read(decision.taskKey);
    const tried = marker?.attempts ?? 0;

    /*
     * Before anything is spent, and counted on this machine's own disk.
     *
     * Reading the record's `attempts` instead was the first shape of this, and it bounded the
     * wrong thing: that number only advances when a settlement LANDS, so the passes it counts are
     * the ones that reported something. A board that will not take the report — an outage, a 409,
     * a url this side refuses — leaves it where it was, while each pass goes on spending
     * `collectDiff`, a push and a `gh pr create` on the owner's pinned token. Exactly the runaway,
     * and exactly the case the counter could not see.
     *
     * Reported as `failed` rather than `refused`: nothing is known to be wrong with the change. A
     * person accepting it again resets the record's count and `recordVerdict` is what clears this
     * marker's, so the pause is theirs to lift.
     */
    if (tried >= MAX_SETTLEMENT_ATTEMPTS) {
      const stopped = await deps.settle({
        taskId: decision.taskId,
        state: decision.state === "declined" ? "discarded" : "failed",
        error: `this machine has tried ${tried} times and stopped; accept it again to have another go`,
        attempts: tried,
      });
      // Only once the board has been told. Otherwise a machine whose board is down stops trying
      // AND stops saying so, which is the silence this ceiling exists to make legible.
      if (stopped && marker) deps.markers.write({ ...marker, attempts: 0, lastAttemptAt: undefined });
      continue;
    }

    // Spaced, not merely counted: five tries against a thirty-second floor is a two-minute budget,
    // which an ordinary redeploy eats whole.
    if (!readyToRetry(marker, now())) continue;
    // A task key is unique per project, not per machine, and `rebind` can put two projects on one
    // checkout. `destroyWorktree` resolves against the project the CONTEXT names, so acting on a
    // row whose project is not the one this worktree was made for deletes the wrong directory —
    // and `parseDecisions` already treats these rows as something to be checked rather than
    // trusted.
    if (marker && marker.projectId !== decision.projectId) {
      // Settled rather than skipped. Skipping leaves the record live for ever — `sweepMarkers`
      // will not take it, nothing ever answers it, and nothing is logged but the same line every
      // poll.
      //
      // And settled from the state it is IN: `refused` is reachable only from `accepted`, so
      // reporting it for a declined row is a 409 on every pass — the same never-ending loop with
      // a write attached. A decline that cannot be carried out is still a decline.
      // Logged as well as settled. The sentence travels in `error`, and a `discarded` settlement
      // has no error field to carry it — so without this the operator's only trace of WHY is
      // whatever the settle call happens to log.
      deps.log(
        `${decision.taskKey}: the decision names project ${decision.projectId}, the worktree here belongs to ${marker.projectId}`
      );
      const stopped =
        decision.state === "declined"
          ? ({ taskId: decision.taskId, state: "discarded" } as const)
          : ({
              taskId: decision.taskId,
              state: "refused",
              error: `the worktree this machine holds for ${decision.taskKey} belongs to another project`,
              attempts: (decision.attempts ?? 0) + 1,
            } as const);
      await deps.settle(stopped);
      continue;
    }

    if (decision.state === "declined") {
      // Counted here as well, cheap though this path is: without it the ceiling's `discarded` arm
      // is unreachable, and the code reads as though a decline stops after five tries when it
      // never would.
      if (marker) deps.markers.write(spent(marker, tried, now));
      // Reported first, and the worktree removed only once the board has taken the answer: the
      // other order deletes the only copy of the work and then finds out the report did not land,
      // leaving a record that still says `declined` with nothing left to decline.
      if (!(await deps.settle({ taskId: decision.taskId, state: "discarded" }))) continue;
      // Removed and said so, rather than left to be found months later.
      await context.destroyWorktree(decision.taskKey).catch((error) => {
        deps.log(`${decision.taskKey}: could not remove the declined worktree: ${String(error)}`);
      });
      deps.markers.remove(decision.taskKey);
      continue;
    }

    if (!marker) {
      await deps.settle({
        taskId: decision.taskId,
        state: "refused",
        error: `this machine no longer holds a worktree for ${decision.taskKey}`,
        attempts: (decision.attempts ?? 0) + 1,
      });
      continue;
    }

    const why = await whyNotPushable(context, marker, decision).catch((error) => String(error));
    if (why) {
      // `refused` and not `failed`: nothing went wrong with the machine, the answer is simply no.
      // Either can be accepted again, so neither is a dead end.
      await deps.settle({
        taskId: decision.taskId,
        state: "refused",
        error: why,
        attempts: (decision.attempts ?? 0) + 1,
      });
      continue;
    }

    // Before the spending, not after it: the whole point is to count a pass that never gets as far
    // as reporting anything.
    deps.markers.write(spent(marker, tried, now));

    try {
      const branch = branchFor(decision.taskKey);
      await context.delivery.push(marker.worktreePath, branch, decision.commit);
      const prUrl = await context.delivery.openPr(
        marker.worktreePath,
        { taskKey: decision.taskKey, title: decision.title },
        PR_BODY
      );
      // Only once the board holds the url. Until then this worktree and this marker are the only
      // things that say where the work is, and a settlement that did not land is retried whole.
      if (!(await deps.settle({ taskId: decision.taskId, state: "delivered", prUrl }))) continue;
      await context.destroyWorktree(decision.taskKey).catch((error) => {
        // Left for the sweep: the decision has left the live list, so the next pass takes it.
        deps.log(`${decision.taskKey}: could not remove the delivered worktree: ${String(error)}`);
      });
      deps.markers.remove(decision.taskKey);
    } catch (error) {
      await deps.settle({
        taskId: decision.taskId,
        state: "failed",
        error: String(error),
        attempts: (decision.attempts ?? 0) + 1,
      });
    }
  }

  await sweepMarkers(deps, decisions, decisionsAsOf);
}

/**
 * A marker whose decision is no longer among the live ones — abandoned by a person, superseded by
 * a second claim, or delivered on an earlier pass whose settlement landed but whose cleanup did
 * not. The worktree it was holding back goes with it.
 *
 * Bounded by when the list was fetched. `refreshServerState` is floored at 30 seconds, so a run
 * that opened a decision a moment ago is not yet in any list this pass has — and sweeping on that
 * would destroy the worktree the person is about to be asked about.
 */
async function sweepMarkers(
  deps: SettleDecisionsDeps,
  decisions: ServerDecision[],
  decisionsAsOf: number
): Promise<void> {
  const live = new Set(decisions.map((decision) => decision.taskKey));

  for (const marker of deps.markers.list()) {
    if (live.has(marker.taskKey)) continue;
    if (Date.parse(marker.createdAt) >= decisionsAsOf) continue;

    const context = await deps.contextFor(marker.projectId);
    if (!context) {
      /*
       * A project this machine no longer serves: it can neither remove the worktree nor reap it,
       * because both resolve through the binding. Keeping the marker is the right answer at first
       * — dropping it hands the directory to a reaper that is equally unable to run, and exempts
       * nothing from anything.
       *
       * But kept for ever it is a state with no exit: the decision is settled, nothing will ever
       * answer it, and `heldTaskKeys` goes on exempting that directory from every future pass,
       * including a sibling project's that shares the root. So it is kept only until the
       * assignment plainly is not coming back, after which the marker goes and an eventual rebind
       * can collect the directory. The worktree itself is a person's to remove; `worker/README.md`
       * says so.
       */
      if (Date.now() - Date.parse(marker.createdAt) > UNBOUND_MARKER_TTL_MS) {
        deps.log(
          `${marker.taskKey}: project ${marker.projectId} has not been served for ${UNBOUND_MARKER_TTL_DAYS} days; releasing the hold on ${marker.worktreePath}, which is yours to remove`
        );
        deps.markers.remove(marker.taskKey);
      }
      continue;
    }

    await context.destroyWorktree(marker.taskKey).catch((error) => {
      deps.log(`${marker.taskKey}: could not remove a settled worktree: ${String(error)}`);
    });
    deps.markers.remove(marker.taskKey);
  }
}

/**
 * What the server said, rebuilt field by field.
 *
 * Server-controlled, like the assignment list beside it, and with a sharper edge: two of these
 * values reach `git` as arguments. A row missing any of them is dropped whole rather than
 * defaulted — a decision with an empty commit would be a push of nothing, reported as delivered.
 */
export function parseDecisions(value: unknown): ServerDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const text = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
    const taskId = text("taskId");
    const projectId = text("projectId");
    const taskKey = text("taskKey");
    const commit = text("commit");
    const state = text("state");
    if (!taskId || !projectId || !state) return [];
    if (!isSafeTaskKey(taskKey)) return [];
    // Checked here as well as at the route that stored it: this is the value that becomes the
    // source half of a push refspec, and the check belongs on the side that spends it.
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return [];
    return [
      {
        taskId,
        projectId,
        taskKey,
        title: text("title"),
        commit,
        patchSha256: text("patchSha256"),
        state,
        attempts: typeof row.attempts === "number" && row.attempts >= 0 ? row.attempts : 0,
      },
    ];
  });
}
