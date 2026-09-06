import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";
import { plantedConfig } from "./repos.js";

const TIMEOUT_MS = 60_000;

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

  const planted = await plantedConfig(runner, worktreePath, configBaseline);
  if (planted) {
    throw new Error(
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
