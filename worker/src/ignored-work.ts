import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { GIT_SAFE_ENV, gitArgs } from "./git-safety.js";

const GIT_TIMEOUT_MS = 60_000;

/**
 * BP-508. `git status --porcelain` honours `.gitignore`, so a rule the run itself committed hides
 * whatever it names from the tree check that runs after every writing step. Measured: with
 * `secret/` added to `.gitignore` in the run's own commit, `status --porcelain` answers clean while
 * `secret/work.ts` holds a day of work.
 *
 * `--ignored` on its own is the wrong answer and `pipeline.ts` already says why: `build` runs
 * `npm ci` and `test-run` runs the suite, so reporting every ignored path fails a run that did
 * nothing wrong. The question is not "is anything ignored" but **"is this the run's doing, or was
 * it always here"** — the same question BP-346's config baseline asks, about a different file.
 *
 * So: only look when the run's own diff touched an ignore file, then ask git which pattern hides
 * each ignored path and whether that pattern predates the run.
 */

const IGNORE_FILE = /(^|\/)\.gitignore$/;
// Untracked, never committed, shared with the main clone through .git — so it appears in no diff
// and no gate ever sees it. A rule from here is the run's by construction: it is not the
// repository's committed policy, because the repository has no way to hold it.
const UNTRACKED_SOURCE = ".git/info/exclude";

interface Hidden {
  path: string;
  rule: string;
}

async function git(runner: Runner, cwd: string, args: string[]) {
  return runner.run("git", gitArgs(args), {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env: { ...childEnv(), ...GIT_SAFE_ENV },
  });
}

function lines(output: string): string[] {
  return output.split("\n").filter((line) => line.trim());
}

/**
 * The paths an ignore rule *this run added* is hiding, or an empty list. `null` when git would not
 * answer — the caller decides what an unexamined tree means, and the one caller treats it the way
 * it treats a failed `status`.
 */
export async function hiddenByTheRunsOwnRules(
  runner: Runner,
  worktreePath: string,
  baseSha: string,
): Promise<Hidden[] | null> {
  const touched = await git(runner, worktreePath, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    baseSha,
    "HEAD",
    "--",
  ]);
  if (touched.code !== 0 || touched.timedOut) return null;

  const changedIgnoreFiles = lines(touched.stdout).filter((path) =>
    IGNORE_FILE.test(path),
  );
  // The ordinary run: no ignore file was touched, so nothing here can be the run's doing and this
  // costs one diff. Everything below runs only for a change that edits what the tree check can see.
  if (changedIgnoreFiles.length === 0) return [];

  const ignored = await git(runner, worktreePath, [
    "status",
    "--porcelain",
    "--ignored",
  ]);
  if (ignored.code !== 0 || ignored.timedOut) return null;

  const hidden: Hidden[] = [];
  for (const line of lines(ignored.stdout)) {
    if (!line.startsWith("!! ")) continue;
    const path = line.slice(3);

    // `source:line:pattern<TAB>path` when a rule matches, exit 1 with no output when none does
    const matched = await git(runner, worktreePath, [
      "check-ignore",
      "-v",
      "--",
      path,
    ]);
    if (matched.timedOut) return null;
    const answer = lines(matched.stdout)[0];
    if (!answer) continue;

    // `source:line:pattern<TAB>path`, and the pattern is what is left after the second colon —
    // taking three fields off a plain split leaves the tab and the path inside it, which made the
    // repository's own `node_modules/` rule compare unequal to itself
    const described = answer.slice(
      0,
      answer.indexOf("\t") === -1 ? undefined : answer.indexOf("\t"),
    );
    const firstColon = described.indexOf(":");
    const secondColon = described.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) continue;
    const source = described.slice(0, firstColon);
    const pattern = described.slice(secondColon + 1);
    if (source === UNTRACKED_SOURCE) {
      hidden.push({ path, rule: `${pattern} in ${source}` });
      continue;
    }
    if (!changedIgnoreFiles.includes(source)) continue;

    const before = await git(runner, worktreePath, [
      "show",
      `${baseSha}:${source}`,
    ]);
    if (before.timedOut) return null;
    // A source the base commit does not have is a file the run added outright
    const predates =
      before.code === 0 && lines(before.stdout).includes(pattern);
    if (!predates) hidden.push({ path, rule: `${pattern} in ${source}` });
  }
  return hidden;
}
