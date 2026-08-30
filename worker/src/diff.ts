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
  // BP-327 put a guard here because the base arrived as free policy text: `--output=<path>` in
  // git's option slot writes that file under the operator's uid, and a positional that no `--` can
  // protect has to be refused before it reaches the command line. BP-382 changed what arrives —
  // workspace.ts resolves the base off the wire and hands over `rev-parse --verify`'s own output —
  // so the guard tightens from "is it a ref name" to "is it an object id". A ref name reaching
  // here would mean some caller went back to naming something the agent can rewrite.
  if (!BASE_OBJECT_ID.test(baseSha)) {
    throw new Error(
      `refusing base ${JSON.stringify(baseSha)}: git would not read it as an object id`,
    );
  }

  const opts: RunOpts = { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS };

  // Resolved once, and every read below names the object id rather than the ref. `HEAD` is a file
  // the agent can rewrite between two calls, so a diff taken from one commit and a review taken
  // from another was a timing question rather than a guarantee — and the review gate now checks
  // this sha out to read the change (BP-404). Same rule the base already follows two blocks up.
  const headSha = (
    await git(runner, ["rev-parse", "--verify", "HEAD^{commit}"], opts)
  ).trim();
  if (!BASE_OBJECT_ID.test(headSha)) {
    throw new Error(
      `refusing head ${JSON.stringify(headSha)}: git would not read it as an object id`,
    );
  }

  // Two trees, not a range: a merge-base is computed from history, and history is what the agent
  // rewrites to hide a file from this diff (BP-382).
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
  // A third read, and the cheapest way to learn a thing `--numstat` cannot express: it prints a
  // symlink as `1  0  <path>`, exactly like a one-line text file. The mode is in `--raw`, and the
  // blob a symlink names IS its target, so one cat-file per symlink answers where it points. Runs
  // for every diff; the cat-file loop runs only when a symlink is actually there.
  const rawOutput = await git(
    runner,
    ["diff", "--no-ext-diff", "--no-textconv", "--raw", baseSha, headSha, "--"],
    opts,
  );
  const symlinks: DiffStats["symlinks"] = [];
  for (const line of rawOutput.split("\n")) {
    // `:<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>`, and a rename carries two paths —
    // the destination is the last, which is the one that exists after the change
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
