import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";
import { plantedConfig } from "./repos.js";

const TIMEOUT_MS = 60_000;

// The agent used to do this, which is the only reason Bash was in its tool list.
export async function commitAll(
  runner: Runner,
  worktreePath: string,
  message: string,
  configBaseline?: readonly string[] | null,
): Promise<string> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV },
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
  // What this does not reach. The scan is `git config --local --list`, and three scopes are
  // invisible to it — measured on git 2.50.1, each one planted and each one's program run:
  // a filter reached through `include.path` (that listing defaults to --no-includes), one in a
  // per-worktree config behind `extensions.worktreeConfig`, and one in ~/.gitconfig, which is not
  // local scope at all. So this refuses a filter written where that scan can see it, which is not
  // the same as refusing every filter; BP-346 is what closes the rest. The refusal below says what
  // was found and deliberately promises nothing about what was not looked for.
  const planted = await plantedConfig(runner, worktreePath, configBaseline);
  if (planted) {
    throw new Error(
      // Phrased to fit both of plantedConfig's answers: a key, and the sentinel it returns when the
      // config cannot be read at all. "sets an unreadable git config" was nonsense for the second.
      `refusing to stage: the checkout now has ${planted}, which it did not when the repository was approved`,
    );
  }

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
