import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";
import { plantedConfig } from "./repos.js";

const TIMEOUT_MS = 60_000;

// The agent used to do this, which is the only reason Bash was in its tool list.
export async function commitAll(
  runner: Runner,
  worktreePath: string,
  message: string
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
  // Before `status`, not merely before `add`. Measured on git 2.50.1: `git status --porcelain` does
  // not run the filter when the file's size changed, and does run it when the size is the same,
  // because that is when git has to read the content to answer.
  //
  // delivery.push runs this same scan, but that is after the payload has already executed here —
  // and a filter that deletes its own config on the way out sails past it.
  const planted = await plantedConfig(runner, worktreePath);
  if (planted) {
    throw new Error(
      `refusing to stage: the checkout's git config sets ${planted}, which was not there when the repository was approved`
    );
  }

  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  if (!status.stdout.trim()) return "";

  const add = await git(["add", "--all", "--"]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

  const commit = await git(["commit", "--no-verify", "-m", message]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);

  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
  return head.stdout.trim();
}
