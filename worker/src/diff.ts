import { childEnv } from "./env.js";
import { Runner, RunOpts } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";
import { DiffStats } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const MAX_PATCH_CHARS = 200_000;

async function git(runner: Runner, args: string[], opts: RunOpts): Promise<string> {
  const result = await runner.run("git", gitArgs(args), {
    ...opts,
    env: { ...childEnv(), ...opts.env, ...GIT_SAFE_ENV },
  });
  if (result.timedOut) {
    throw new Error(`git ${args[0]} timed out after ${opts.timeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function resolveRenamedPath(rawPath: string): string {
  const braceMatch = /^(.*)\{.* => (.*)\}(.*)$/.exec(rawPath);
  if (braceMatch) {
    const [, prefix, renamedTo, suffix] = braceMatch;
    return `${prefix}${renamedTo}${suffix}`;
  }
  const arrowIndex = rawPath.indexOf(" => ");
  return arrowIndex === -1 ? rawPath : rawPath.slice(arrowIndex + " => ".length);
}

function parseNumstat(output: string): Pick<DiffStats, "changedLines" | "changedFiles"> {
  let changedLines = 0;
  const changedFiles: string[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, rawPath] = line.split("\t");
    if (!rawPath) continue;

    changedFiles.push(resolveRenamedPath(rawPath.trim()));
    if (added !== "-" && removed !== "-") {
      changedLines += Number(added) + Number(removed);
    }
  }

  return { changedLines, changedFiles };
}

function boundPatch(patch: string): Pick<DiffStats, "patch" | "truncated"> {
  if (patch.length <= MAX_PATCH_CHARS) return { patch, truncated: false };
  const cut = patch.lastIndexOf("\n", MAX_PATCH_CHARS);
  const kept = patch.slice(0, cut > 0 ? cut : MAX_PATCH_CHARS);
  return {
    patch: `${kept}\n\n[patch truncated: exceeded ${MAX_PATCH_CHARS} characters]`,
    truncated: true,
  };
}

export async function collectDiff(
  runner: Runner,
  worktreePath: string,
  baseSha: string
): Promise<DiffStats> {
  const opts: RunOpts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };
  // Two trees, not a range: a merge-base is computed from history, and history is what the agent
  // rewrites to hide a file from this diff (BP-382).
  const numstatOutput = await git(
    runner,
    ["diff", "--no-ext-diff", "--no-textconv", "--numstat", baseSha, "HEAD"],
    opts
  );
  const { changedLines, changedFiles } = parseNumstat(numstatOutput);

  // --no-ext-diff: a repo-local diff.external replaces the patch git prints with a program's
  // output, so the review gate would read attacker-chosen text while the commit held something
  // else — measured. repos.ts flags diff.external and the push refuses on it, but that is a
  // poisoned review followed by a refused push; this closes it where the diff is taken.
  //
  // --no-textconv: the sibling leaf. diff.<driver>.textconv is the same substitution through a
  // per-path attribute (.git/info/attributes, itself untracked and invisible to protected-paths)
  // instead of a blanket repo setting — measured with the attribute and driver both planted: an
  // unguarded call returns an empty patch and runs the textconv program, which is Bash back under
  // an agent this pipeline took Bash away from.
  const patchOutput = await git(runner, ["diff", "--no-ext-diff", "--no-textconv", baseSha, "HEAD"], opts);
  const { patch, truncated } = boundPatch(patchOutput);

  return { changedLines, changedFiles, patch, truncated };
}
