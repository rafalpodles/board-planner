import { childEnv } from "./env.js";
import { Runner, RunOpts } from "./exec.js";
import { gitArgs, GIT_SAFE_ENV } from "./git-safety.js";
import { DiffStats } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const BASE_OBJECT_ID = /^[0-9a-f]{7,64}$/;
const MAX_PATCH_CHARS = 200_000;

async function git(
  runner: Runner,
  args: string[],
  opts: RunOpts,
): Promise<string> {
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
  return arrowIndex === -1
    ? rawPath
    : rawPath.slice(arrowIndex + " => ".length);
}

function parseNumstat(
  output: string,
): Pick<DiffStats, "changedLines" | "changedFiles"> {
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
  baseSha: string,
): Promise<DiffStats> {
  if (!BASE_OBJECT_ID.test(baseSha)) {
    throw new Error(
      `refusing base ${JSON.stringify(baseSha)}: git would not read it as an object id`,
    );
  }

  const opts: RunOpts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };

  const headSha = (
    await git(runner, ["rev-parse", "--verify", "HEAD^{commit}"], opts)
  ).trim();
  if (!BASE_OBJECT_ID.test(headSha)) {
    throw new Error(
      `refusing head ${JSON.stringify(headSha)}: git would not read it as an object id`,
    );
  }

  const numstatOutput = await git(
    runner,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      baseSha,
      headSha,
      "--",
    ],
    opts,
  );
  const { changedLines, changedFiles } = parseNumstat(numstatOutput);

  const rawOutput = await git(
    runner,
    ["diff", "--no-ext-diff", "--no-textconv", "--raw", baseSha, headSha, "--"],
    opts,
  );
  const symlinks: DiffStats["symlinks"] = [];
  for (const line of rawOutput.split("\n")) {
    if (!line.startsWith(":")) continue;
    const [meta, ...paths] = line.split("\t");
    const fields = meta.slice(1).split(/\s+/);
    if (fields[1] !== "120000") continue;
    const path = paths[paths.length - 1];
    const target = await git(runner, ["cat-file", "blob", fields[3]], opts);
    symlinks.push({ path, target: target.trim() });
  }

  const patchOutput = await git(
    runner,
    ["diff", "--no-ext-diff", "--no-textconv", baseSha, headSha, "--"],
    opts,
  );
  const { patch, truncated } = boundPatch(patchOutput);

  return { changedLines, changedFiles, patch, truncated, headSha, symlinks };
}
