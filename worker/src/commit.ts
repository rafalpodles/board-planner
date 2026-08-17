import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";

const TIMEOUT_MS = 60_000;

// The agent used to do this, which is the only reason Bash was in its tool list.
export async function commitAll(
  runner: Runner,
  worktreePath: string,
  message: string
): Promise<void> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV },
    });

  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  if (!status.stdout.trim()) return;

  const add = await git(["add", "--all", "--"]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

  const commit = await git(["commit", "--no-verify", "-m", message]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}
