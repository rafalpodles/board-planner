import { Runner } from "./exec.js";
import { gitArgs, localGitEnv, operatorGitEnv } from "./git-safety.js";
import { plantedConfig } from "./repos.js";

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
 * The name and address the commits of this run carry.
 *
 * Read where the run will commit, so a per-repository identity is still honoured, and read *before*
 * the agent runs for the same reason `baseSha` is resolved early: `~/.gitconfig` is a file the agent
 * can write. `null` when the operator has configured none, which is the state git itself refuses to
 * commit in — with a message that says exactly what to run, so this does not invent one over the top
 * of it.
 */
export async function resolveCommitIdentity(
  runner: Runner,
  cwd: string,
): Promise<CommitIdentity | null> {
  const read = async (key: string): Promise<string> => {
    const result = await runner.run("git", gitArgs(["config", "--get", key]), {
      cwd,
      timeoutMs: TIMEOUT_MS,
      env: operatorGitEnv(),
    });
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  };

  const [name, email] = [await read("user.name"), await read("user.email")];
  return name && email ? { name, email } : null;
}

// The agent used to do this, which is the only reason Bash was in its tool list.
export async function commitAll(
  runner: Runner,
  worktreePath: string,
  message: string,
  identity?: CommitIdentity | null,
): Promise<string> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: TIMEOUT_MS,
      // The identity in the environment rather than as `-c user.email=…`: these variables are what
      // git reads last, they are the only knob for the committer as distinct from the author, and
      // localGitEnv has just taken the file the values would otherwise have come from.
      env: localGitEnv(
        [],
        identity
          ? {
              GIT_AUTHOR_NAME: identity.name,
              GIT_AUTHOR_EMAIL: identity.email,
              GIT_COMMITTER_NAME: identity.name,
              GIT_COMMITTER_EMAIL: identity.email,
            }
          : {},
      ),
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
