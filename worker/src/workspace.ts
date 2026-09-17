import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import {
  CommitIdentity,
  MissingIdentityError,
  ResolvedIdentity,
  resolveCommitIdentity,
} from "./commit.js";
import { WorkerConfig } from "./config.js";
import { plantedConfig, UNREADABLE_CONFIG } from "./repos.js";
import { CommandResult, Runner } from "./exec.js";
import { gitArgs, localGitEnv } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Which of the two things went wrong, because they are owed opposite treatment.
 *
 * `transport` — the remote could not be reached, or would not serve what it was asked for. Nothing
 * about the task caused it and the next task would fail identically, so the run is released with
 * its attempt refunded and the worker backs off.
 * `configuration` — the remote answered, and this repository has no such base branch. That belongs
 * to the project rather than the machine, it repeats until a human changes something, and every
 * other project on this worker is unaffected: the attempt is charged so the task escalates.
 */
export type BaseFaultKind = "transport" | "configuration";

/** The base could not be established from the remote. */
export class BaseUnavailableError extends Error {
  readonly kind: BaseFaultKind;

  constructor(message: string, kind: BaseFaultKind = "transport") {
    super(message);
    this.name = "BaseUnavailableError";
    this.kind = kind;
  }
}

/**
 * The shared checkout carries a key git would run, and the run is over before it does.
 *
 * Its own class because the pipeline owes this a different answer from every other creation
 * failure: the task did nothing, and the next task on this machine meets the same key.
 */
export class PoisonedCheckoutError extends Error {
  /** What was found — a key with its scope, or plantedConfig's sentinel for a config it cannot read. */
  readonly finding: string;

  /**
   * Which of the two, because they are owed different treatment — the same split, and for the same
   * reason, as `BaseUnavailableError.kind` above.
   *
   * `planted` — a key somebody put there. It repeats until a human removes it, so the project is
   * quarantined and the machine stops offering it.
   * `unreadable` — git would not answer. A checkout that has just been moved or re-cloned, a
   * machine under load, a 60-second timeout. The run is still refused, because a config this
   * cannot read is one it cannot vouch for — but latching a project off until the process
   * restarts on the strength of one bad answer is a different claim, and a wrong one.
   */
  readonly kind: "planted" | "unreadable";

  constructor(finding: string) {
    // Branched rather than phrased to fit both: this message is the only account of the failure
    // that reaches the board, and "an unreadable git config is in the git config" sends a person
    // looking for a planted key that was never found.
    super(
      finding === UNREADABLE_CONFIG
        ? "refusing to check out: the shared checkout's git config could not be read, so nothing can vouch for what a checkout would run"
        : `refusing to check out: ${JSON.stringify(finding)} is in the shared checkout's git config, and a checkout is where git runs one`
    );
    this.name = "PoisonedCheckoutError";
    this.finding = finding;
    this.kind = finding === UNREADABLE_CONFIG ? "unreadable" : "planted";
  }
}

export interface Worktree {
  path: string;
  /** Resolved before the agent runs and held in this process: a ref name is rewritable by the run. */
  baseSha: string;
  /**
   * Who this run's commits are by, resolved before the worktree exists and held in this process for
   * the same reason `baseSha` is. Every git call inside the checkout has `~/.gitconfig` out of the
   * picture (BP-516), so the identity that file holds has to travel with the run rather than be
   * read back at the commit.
   *
   * It is not evidence of who ran anything, and reading it early does not make it so: an earlier
   * run's agent can put a `user.email` in that file or in the shared `.git/config`, and neither is
   * a key git *runs*, so no scan refuses it. What a commit says about its author is worth exactly
   * what the machine's own configuration is worth. The identity a push acts under is pinned
   * separately (BP-373).
   *
   * Never absent: a machine git will not name an identity for is refused at `create`, before the
   * agent runs, rather than at the commit an hour of somebody's subscription later.
   */
  commitIdentity: CommitIdentity;
}

export interface Workspace {
  create(taskKey: string, slug: string): Promise<Worktree>;
  destroy(taskKey: string): Promise<void>;
  listWorktrees(): Promise<string[]>;
}

// A worktree under the worker's own root belongs to a run that died with its process. Nothing
// holds it, and leaving it there makes the next attempt on that task collide with its own branch
//
// `held` is the exception, and it is required rather than defaulted for the reason
// `quarantineProject` is: an assembly that forgot it would destroy the one copy of a change
// somebody is being asked to accept, and would do it without anything failing to compile (BP-381).
export async function reapOrphans(
  workspace: Workspace,
  worktreeRoot: string,
  held: ReadonlySet<string>
): Promise<number> {
  const prefix = worktreeRoot.endsWith(sep) ? worktreeRoot : `${worktreeRoot}${sep}`;
  const orphans = (await workspace.listWorktrees().catch(() => []))
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter((taskKey) => taskKey.length > 0 && !taskKey.includes(sep))
    .filter((taskKey) => !held.has(taskKey));

  for (const taskKey of orphans) {
    await workspace.destroy(taskKey).catch(() => {});
  }
  return orphans.length;
}

export function createWorkspace(
  config: WorkerConfig,
  runner: Runner,
  remoteEnv?: () => NodeJS.ProcessEnv,
  remoteUrl?: string
): Workspace {
  // api.ts refuses a key that is not a name; this is the sink where a key becomes a path, and the
  // only place that can still tell a traversal from a directory name
  function pathFor(taskKey: string): string {
    const root = resolve(config.worktreeRoot);
    const path = resolve(root, taskKey);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(
        `refusing task key ${JSON.stringify(taskKey)}: its path falls outside the worktree root ${root}`
      );
    }
    return path;
  }

  async function git(args: string[]): Promise<string> {
    const result = await runner.run("git", gitArgs(args), {
      cwd: config.repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: localGitEnv(),
    });
    if (result.timedOut) {
      throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`);
    }
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  async function registeredWorktreePaths(): Promise<string[]> {
    const output = await git(["worktree", "list", "--porcelain"]);
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }

  async function removeIfRegistered(path: string): Promise<void> {
    if ((await registeredWorktreePaths()).includes(path)) {
      await git(["worktree", "remove", "--force", "--", path]);
    }
  }

  // The answer must not come from anything repoPath/.git can redirect, and passing `url` rather
  // than the remote name `origin` is not enough to achieve that: a repository-local
  // url.<x>.insteadOf rewrites every URL git sees, including one given literally in argv, and no
  // GIT_CONFIG_* variable turns that off — GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL drop the
  // system and global files only. Measured; the comment that used to stand here claimed the
  // opposite and the gate was reopened through it.
  //
  // GH_CONFIG_DIR/XDG_CONFIG_HOME travel with it for the same reason delivery.ts carries them: the
  // credential helper is `gh`, and an operator who moved gh's config would otherwise be able to
  // push but not to resolve a base.
  //
  // No `-c` flags ride along: gitArgs()'s `-c credential.helper=` is the last thing git evaluates,
  // and for that multi-valued key it silently discards whatever env() installed — verified
  // empirically, and it made every https fetch fail to authenticate. hardenedGitConfig() already
  // covers hooksPath/fsmonitor/pager/protocol for this class of call, same as delivery's push.
  async function remoteRun(
    env: () => NodeJS.ProcessEnv,
    cwd: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): Promise<CommandResult> {
    const result = await runner.run("git", args, {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      env: {
        ...localGitEnv(
          ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"],
          // The neutral GIT_DIR rides in the middle slot rather than after the hardening, so this
          // call site cannot decide what git reads on its way past (BP-516 review).
          extraEnv,
        ),
        ...env(),
      },
    });
    // A killed child contributes no stderr, so without this a 60 s hang and an instant refusal by
    // the server read identically to whoever has to diagnose it.
    if (result.timedOut) {
      return { ...result, stderr: `git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms` };
    }
    return result;
  }

  // Where the call that decides the base runs. `os.tmpdir()` is NOT a safe place for it: the agent
  // is handed TMPDIR (env.ts's allowlist) and can write there, the directory persists between
  // runs, and a `.git` file planted in it is honoured — GIT_CEILING_DIRECTORIES cannot prevent
  // that, because git documents that the ceiling never excludes the working directory itself, and
  // an entry equal to cwd is not even a proper ancestor, so it matches nothing at all. Measured.
  //
  // So: a fresh directory this process creates (mkdtemp is 0700 and its name is unpredictable, so
  // nothing can be lying in wait inside it), plus an explicit GIT_DIR, which makes git skip
  // repository discovery outright rather than merely bounding it.
  function withNeutralGitHome<T>(run: (opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "bp-worker-base-"));
    return run({
      cwd: dir,
      env: { GIT_DIR: join(dir, "no-repository"), GIT_CEILING_DIRECTORIES: tmpdir() },
    }).finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a leftover empty temp directory is not worth failing a run over
      }
    });
  }

  // ls-remote matches its pattern against the *tail* of a ref name at a `/` boundary, so asking
  // for refs/heads/main also returns refs/heads/aaa/refs/heads/main — which sorts first. Taking
  // the first line hands the base to anyone who can push a branch to the base repository, which
  // includes this worker. Only the exact ref counts.
  function shaForExactRef(lsRemoteStdout: string, ref: string): string {
    for (const line of lsRemoteStdout.split("\n")) {
      // ls-remote prints exactly `<oid> TAB <ref>`; the ref name is what has to match, and the
      // object id is verified as an object further down rather than by its spelling here.
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha) return sha;
    }
    return "";
  }

  // FETCH_HEAD, refs/remotes/origin/<branch> — whatever `git fetch` leaves behind to say what it
  // got — lives in the same shared ref store this module stopped trusting names in. BP-349's
  // confinement keeps the agent out of it, and none of what follows leans on that: the store is
  // shared with every other worktree of this clone, and the confinement is the operator's to
  // switch off. ls-remote's answer is read straight off this process's own stdout, in memory, before
  // anything is written to disk; rev-parse is then asked about that exact object id, a
  // content-addressed lookup no planted ref can redirect. The fetch itself may still be
  // redirected — it has to run inside the clone to write objects there — but that is harmless:
  // a server the agent points us at cannot make *this* sha appear.
  async function resolveFreshBase(env: () => NodeJS.ProcessEnv, url: string): Promise<string> {
    const ref = `refs/heads/${config.baseBranch}`;
    const lsRemote = await withNeutralGitHome(({ cwd, env: neutralEnv }) =>
      remoteRun(env, cwd, ["ls-remote", "--", url, ref], neutralEnv)
    );
    if (lsRemote.code !== 0) {
      throw new BaseUnavailableError(
        `could not read ${ref} from ${url} (${lsRemote.stderr || lsRemote.stdout || "ls-remote failed"})`
      );
    }

    const remoteSha = shaForExactRef(lsRemote.stdout, ref);
    if (!remoteSha) {
      throw new BaseUnavailableError(`${url} did not report ${ref}`, "configuration");
    }

    // `--` guards both positional arguments: without it a value beginning with a dash is read as
    // an option, and --upload-pack=<cmd> runs that command. delivery.ts guards its push the same
    // way, for the same reason.
    const fetched = await remoteRun(env, config.repoPath, [
      "fetch",
      "--no-tags",
      "--",
      url,
      config.baseBranch,
    ]);
    if (fetched.code !== 0) {
      throw new BaseUnavailableError(
        `could not fetch ${config.baseBranch} from ${url} (${fetched.stderr || fetched.stdout || "fetch failed"})`
      );
    }

    // `^{commit}` is load-bearing, and it is the only thing proving the fetch actually delivered
    // anything: `rev-parse --verify <sha>` exits 0 for an object that is NOT present and simply
    // echoes the sha back, while `<sha>^{commit}` requires it locally. It refuses a blob or a
    // tree; it does not refuse an annotated tag — it peels one, returning a different sha than the
    // one asked for, which is why the result is what gets used rather than remoteSha.
    try {
      return (await git(["rev-parse", "--verify", `${remoteSha}^{commit}`])).trim();
    } catch (error) {
      throw new BaseUnavailableError(
        `fetched ${config.baseBranch} from ${url} but ${remoteSha} did not resolve afterwards (${String(error)})`
      );
    }
  }

  // There is deliberately no fallback to the local ref. That ref is writable by the agent of any
  // run that has ever executed against this checkout and it survives between runs, so reading it
  // is the vulnerability this module exists to close — and an agent can force a fallback on
  // purpose by planting an http.proxy or an insteadOf that points at nothing. A base that cannot
  // be verified fails the run instead: an operator sees why, and no gate ever judges a diff
  // against a base somebody else chose.
  async function resolveBase(): Promise<string> {
    if (!remoteEnv || !remoteUrl) {
      throw new BaseUnavailableError(
        `no remote is configured for this checkout, so ${config.baseBranch} could only be read from the local ref store, which a previous run's agent can write`,
        "configuration"
      );
    }
    return resolveFreshBase(remoteEnv, remoteUrl);
  }

  /**
   * `git worktree add` checks files **out**, and a checkout is where a `filter.<name>.smudge`
   * runs — so a key an earlier run's agent planted in the shared `<main>/.git/config` executes
   * inside this module, on every later attempt, before any gate has seen anything. BP-403's guard
   * is in `commitAll`, downstream of the run this one would already have started. Measured on git
   * 2.50.1: workspace.planted-config.integration.test.ts plants one and watches git run it.
   *
   * No baseline is passed, and none would help: this runs before the run a baseline exists to
   * date, and the machine scopes it would unlock are neutralised on these calls instead.
   */
  /**
   * Whether the machine has nobody to commit as, or this checkout is what broke the answer.
   *
   * Asked in a directory with no repository in it, so the answer is the machine's own config and
   * nothing else. It matters because the two settlements are opposite, and the cheaper key is the
   * one that used to cost more: `user.name = ""` in the shared `.git/config` is well-formed,
   * carries no program, is invisible to every scan — and made `git var` refuse, which released the
   * whole worker's pass. An executable key planted beside it only quarantines its own checkout
   * (BP-516 review).
   */
  async function whoseFault(inTheCheckout: ResolvedIdentity): Promise<"machine" | "checkout"> {
    if (inTheCheckout.ok) return "machine";
    const onTheMachine = await withNeutralGitHome(({ cwd, env }) =>
      resolveCommitIdentity(runner, cwd, env),
    );
    return onTheMachine.ok ? "checkout" : "machine";
  }

  async function refuseIfPoisoned(): Promise<void> {
    // The scan and the checkout read the same config, because both go through `localGitEnv`. A scan
    // judging a config git will not read answers a different question from the one asked, in both
    // directions: it would refuse over an operator's own credential helper, and — measured — one
    // malformed line in `~/.gitconfig` makes `--local --list` exit 128, which is read as unreadable
    // and refuses every project on the machine until somebody notices.
    const planted = await plantedConfig(runner, config.repoPath);
    if (planted) throw new PoisonedCheckoutError(planted);
  }

  return {
    async create(taskKey, slug) {
      const path = pathFor(taskKey);
      const branch = `${taskKey.toLowerCase()}/${slug}`;

      // First, ahead of the fetch and well ahead of `worktree add`. That command checks files
      // **out**, and a checkout is exactly where a `filter.<name>.smudge` runs — so a key planted
      // in the shared `<main>/.git/config` by an earlier run's agent executes inside this call, on
      // every later attempt, before any gate has seen anything. BP-403's guard is in `commitAll`,
      // downstream of the run this one would already have started. Measured on git 2.50.1:
      // workspace.planted-config.integration.test.ts plants one and watches git run it.
      await refuseIfPoisoned();

      // Before the fetch and before the worktree: a machine git will not name an identity for
      // fails every task it takes, and raising it after `worktree add` left an orphan worktree
      // behind on every faulted claim, one per poll (BP-516 review). Read in the shared checkout,
      // which is the config a linked worktree has — the per-worktree scope is the only thing that
      // could differ, and a key in it is refused above.
      const identity = await resolveCommitIdentity(runner, config.repoPath);
      if (!identity.ok) throw new MissingIdentityError(identity.reason, await whoseFault(identity));

      let baseSha: string;
      try {
        baseSha = await resolveBase();
      } catch (error) {
        // A BaseUnavailableError already says which branch, which remote and what git answered, so
        // wrapping it restated the first clause of its own message — "could not resolve base
        // branch main: could not read refs/heads/main from …" — inside a notification budget of
        // two hundred characters (BP-619). Rethrown as it is, kind and all.
        if (error instanceof BaseUnavailableError) throw error;
        // Anything else reached here without naming the subject, so this is where it is named. The
        // pipeline tells a machine fault from a project's own misconfiguration by the kind, and an
        // unexpected throw is this machine's until something says otherwise.
        throw new BaseUnavailableError(
          `could not resolve base branch ${config.baseBranch}: ${String(error)}`,
          "transport"
        );
      }

      await removeIfRegistered(path);
      // Again, immediately before the checkout. The scan above and this command are separate
      // processes with a fetch between them — two network round-trips, which is a window an
      // attacker with a watcher can win: measured, replanting 50ms after the first scan got the
      // payload run five times out of five. This does not close the race, and nothing short of not
      // sharing `.git` would; it shortens it from two round-trips to one spawn.
      await refuseIfPoisoned();
      // -B resets the branch instead of failing if a crashed previous attempt already created it
      await git(["worktree", "add", "-B", branch, "--", path, baseSha]);
      return { path, baseSha, commitIdentity: identity.identity };
    },

    async destroy(taskKey) {
      await removeIfRegistered(pathFor(taskKey));
    },

    listWorktrees() {
      return registeredWorktreePaths();
    },
  };
}
