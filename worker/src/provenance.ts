import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

// commitAll is the only thing in this worker that commits, so a run knows every sha it created.
// Anything else between the base and HEAD was put there by the thing being judged.
export async function unexpectedHistory(
  runner: Runner,
  worktreePath: string,
  baseSha: string,
  expected: string[]
): Promise<string> {
  const git = (args: string[]) =>
    runner.run("git", gitArgs(args), {
      cwd: worktreePath,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...childEnv(), ...GIT_SAFE_ENV },
    });

  const range = await git(["rev-list", `${baseSha}..HEAD`]);
  if (range.code !== 0) {
    return `git rev-list ${baseSha}..HEAD failed: ${range.stderr || range.stdout}`;
  }

  const found = range.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const mine = new Set(expected);
  const foreign = found.filter((sha) => !mine.has(sha));
  if (foreign.length > 0) {
    return `the branch carries ${foreign.length} commit(s) this run did not make (${foreign.join(", ")})`;
  }
  if (found.length !== expected.length) {
    return `the branch carries ${found.length} commit(s), but this run made ${expected.length}`;
  }

  const head = await git(["rev-parse", "HEAD"]);
  const newest = expected[expected.length - 1] ?? baseSha;
  if (head.stdout.trim() !== newest) {
    return `HEAD is ${head.stdout.trim() || "unreadable"}, not this run's last commit ${newest}`;
  }
  return "";
}
