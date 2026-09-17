import { Runner } from "./exec.js";
import { gitArgs, localGitEnv, operatorGitEnv } from "./git-safety.js";
import { plantedConfig, UNREADABLE_CONFIG } from "./repos.js";

const TIMEOUT_MS = 60_000;

/** Who the worker's commits are by, resolved from the operator's config before the agent ran. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * The checkout carries a key git would run, found where the staging is about to happen.
 *
 * Its own class for the reason `PoisonedCheckoutError` is one: the pipeline owes this a different
 * answer from a failed `git add`. The tree it refused to stage is the evidence — the config the
 * agent planted is in it — and a requeue that destroyed it left an operator with a comment naming a
 * key and nothing to look at (BP-506).
 */
export class TamperedCheckoutError extends Error {
  /** What was found — a key with its scope, or plantedConfig's sentinel for a config it cannot read. */
  readonly finding: string;

  constructor(finding: string) {
    super(
      `refusing to stage: the checkout now has ${finding}, which it did not when the repository was approved`,
    );
    this.name = "TamperedCheckoutError";
    this.finding = finding;
  }
}

/**
 * This machine has nobody to commit as, or git would not say who.
 *
 * A machine fault rather than the task's failure: every task it claims meets the same wall, and the
 * one thing to do about it is on the machine. Raised before the agent runs rather than at the
 * commit, so nothing is spent finding out. It carries git's own answer, because the two causes need
 * different repairs — nothing configured, or a config file git will not parse.
 */
export class MissingIdentityError extends Error {
  /**
   * Whose fault it is, because the two are owed opposite treatment and one key tells them apart.
   *
   * `machine` — nothing on this machine names an identity, or its config file will not parse. Every
   * task it claims meets the same wall, so the run is released with its attempt refunded and the
   * loop stops claiming for the pass.
   * `checkout` — the machine is fine and this repository's own config breaks the answer. A
   * `user.name = ""` in the shared `.git/config` does it: well-formed, non-executable, invisible to
   * every scan, and `git var` refuses. That belongs to the project, it repeats until a human
   * changes something, and no other project on the machine is affected — so the attempt is charged
   * and the task escalates, the way an unusable base branch does. Left undistinguished, the least
   * capable key an agent can plant took a whole worker's pass, where an executable one only
   * quarantines its own checkout (BP-516 review).
   */
  readonly kind: "machine" | "checkout";

  constructor(reason: string, kind: "machine" | "checkout" = "machine") {
    super(
      kind === "machine"
        ? `this machine has no git identity to commit as: ${reason}`
        : `this checkout's own git config leaves no identity to commit as: ${reason}`,
    );
    this.name = "MissingIdentityError";
    this.kind = kind;
  }
}

/** What `resolveCommitIdentity` answers: an identity, or git's own account of why there is none. */
export type ResolvedIdentity =
  | { ok: true; identity: CommitIdentity }
  | { ok: false; reason: string };

// `Name <address> <unix time> <zone>`. git strips `<`, `>` and newlines out of both halves before
// printing — measured, `user.name = "a<b>c"` prints as `abc` — so there is exactly one of each and
// the address is framed unambiguously. An empty half is refused rather than passed on: `user.email
// = ""` makes git answer `Name <> …` with exit 0, and a commit made with that lands with no author
// address at all, pushed and merged (BP-516 review).
function parseIdent(line: string): CommitIdentity | null {
  const opened = line.indexOf("<");
  const closed = line.lastIndexOf(">");
  if (opened === -1 || closed < opened) return null;
  const name = line.slice(0, opened).trim();
  const email = line.slice(opened + 1, closed).trim();
  return name && email ? { name, email } : null;
}

/**
 * The name and address the commits of this run carry.
 *
 * Asked of git rather than assembled from two `--get`s, because the two are not the same question:
 * with `user.email` set and no `user.name`, git fills the name from the account's GECOS field and
 * commits — measured — while reading the keys one at a time finds half an identity and has to
 * decide what to do with it. `git var GIT_AUTHOR_IDENT` is that decision, made by the thing that
 * would otherwise make it at the commit.
 *
 * Read where the run will commit, so a per-repository identity is still honoured, and read *before*
 * the agent runs for the same reason `baseSha` is resolved early: `~/.gitconfig` is a file the agent
 * can write.
 *
 * What it is not: proof of who ran anything. An earlier run's agent can put a `user.email` in that
 * file or in the shared `.git/config` — neither is a key git *runs*, so no scan refuses it — and
 * every later commit then carries that name. The push identity is pinned separately (BP-373); this
 * is only what the commit object says.
 */
export async function resolveCommitIdentity(
  runner: Runner,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ResolvedIdentity> {
  const result = await runner.run("git", gitArgs(["var", "GIT_AUTHOR_IDENT"]), {
    cwd,
    timeoutMs: TIMEOUT_MS,
    env: operatorGitEnv(extraEnv),
  });
  if (result.timedOut) return { ok: false, reason: `git var timed out after ${TIMEOUT_MS}ms` };
  if (result.code !== 0) {
    // git's whole answer, not its last line. It says which of the two faults this is AND what to
    // do: "Author identity unknown" is followed by the two commands to run, six lines down, and
    // keeping only the tail threw them away while the prose promised them. "fatal: bad config line
    // 4 in file …" is one line and survives either way. The reason reaches a board comment, where
    // the budget is two thousand characters and this block is about three hundred (BP-516 review).
    const said = (result.stderr || result.stdout).trim();
    return { ok: false, reason: said || "git would not say who this machine commits as" };
  }

  const identity = parseIdent(result.stdout.trim());
  return identity
    ? { ok: true, identity }
    : { ok: false, reason: `git answered ${JSON.stringify(result.stdout.trim())}, which is not an identity` };
}

// The agent used to do this, which is the only reason Bash was in its tool list.
export async function commitAll(
  runner: Runner,
  worktreePath: string,
  message: string,
  identity: CommitIdentity,
): Promise<string> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: TIMEOUT_MS,
      // The identity in the environment rather than as `-c user.email=…`: these variables are what
      // git reads last, they are the only knob for the committer as distinct from the author, and
      // localGitEnv has just taken the file the values would otherwise have come from.
      env: localGitEnv([], {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      }),
    });

  // The agent holds Write under .git in a linked worktree, so between bindRepository's scan and
  // this call it can add `[filter "z"] clean = <its own script>` to .git/config and `* filter=z` to
  // .git/info/attributes — untracked, shared with the main clone, invisible to protected-paths.
  // git then runs that program, as this process's uid and with this process's environment, while
  // the worker stages the agent's work. gitArgs cannot close it: `-c` neutralises a key by name and
  // filter names are the agent's to choose, so there is no filter.* to override.
  //
  // Before `status`, not merely before `add`. `git status --porcelain` reads a file's content —
  // and so runs the filter — whenever size and stat cannot answer "modified?" on their own.
  // Measured on git 2.50.1:
  //
  //   tracked, size changed    status: no     add: yes
  //   tracked, same size       status: YES    add: yes
  //   untracked, any size      status: YES    add: yes
  //
  // The untracked row is the one that matters here: a file the agent newly wrote is the ordinary
  // case in this pipeline, and for it `status` runs the filter unconditionally.
  //
  // delivery.push runs this same scan, but that is after the payload has already executed here —
  // and a filter that deletes its own config on the way out sails past it.
  //
  // What this reaches is what the calls below read, and no more: the scan and the staging run in
  // the same environment, so `~/.gitconfig` is outside both (BP-516) and a filter reached through
  // `include.path` is refused as the indirection it is rather than followed. That leaves the
  // repository's own scopes, which is where a filter now has to be defined to run at all.
  const planted = await plantedConfig(runner, worktreePath);
  // Only a key somebody planted is a refusal a person has to look at. A config git would not read
  // at all is a checkout being re-cloned or a machine under load — it still stops the commit,
  // because a config this cannot read is one it cannot vouch for, but as an ordinary failure that
  // requeues rather than one that parks the task and keeps a worktree as evidence of nothing
  // (BP-516 review; UNREADABLE_CONFIG's own docstring says the two are owed different treatment).
  if (planted === UNREADABLE_CONFIG) {
    throw new Error(
      "refusing to stage: the checkout's git config could not be read, so nothing can vouch for what a commit would run",
    );
  }
  if (planted) throw new TamperedCheckoutError(planted);

  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0)
    throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  if (!status.stdout.trim()) return "";

  const add = await git(["add", "--all", "--"]);
  if (add.code !== 0)
    throw new Error(`git add failed: ${add.stderr || add.stdout}`);

  const commit = await git(["commit", "--no-verify", "-m", message]);
  if (commit.code !== 0)
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);

  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0)
    throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
  return head.stdout.trim();
}
