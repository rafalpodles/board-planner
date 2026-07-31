import { Runner, RunOpts } from "./exec.js";
import { DiffStats } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const MAX_PATCH_CHARS = 200_000;

async function git(runner: Runner, args: string[], opts: RunOpts): Promise<string> {
  const result = await runner.run("git", args, opts);
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
  baseBranch: string
): Promise<DiffStats> {
  const opts: RunOpts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };
  // three-dot: diffs from the merge-base, so a baseBranch that keeps moving concurrently doesn't pollute the diff
  const range = `${baseBranch}...HEAD`;

  const numstatOutput = await git(runner, ["diff", "--numstat", range], opts);
  const { changedLines, changedFiles } = parseNumstat(numstatOutput);

  const patchOutput = await git(runner, ["diff", range], opts);
  const { patch, truncated } = boundPatch(patchOutput);

  return { changedLines, changedFiles, patch, truncated };
}
