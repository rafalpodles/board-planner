import { lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { childEnv } from "./env.js";
import { Runner } from "./exec.js";
import { gitArgs, localGitEnv, requireGitPath } from "./git-safety.js";

const TIMEOUT_MS = 60_000;
const QUOTED_AT_MOST = 160;
const NAMED_AT_MOST = 5;

/**
 * Where a worktree's repository is, as git set it up before the agent ran (BP-794).
 *
 * A linked worktree's `.git` is a file inside the worktree saying `gitdir: <path>`, and a confined
 * step can rewrite it: a git dir of text files beside it — `objects/info/alternates` pointing at the
 * main clone's objects, a `HEAD`, a ref, a `config` — then becomes the repository every later git
 * call in that directory uses, remote and index included. `GIT_DIR` and `GIT_WORK_TREE` make git
 * skip that file altogether; the `commondir` it derives the shared repository from sits in the
 * main clone's `.git/worktrees/<name>/`, which a confined step cannot write. An unconfined one
 * (`CP_ALLOW_UNCONFINED_AGENT=1`) can, and nothing here holds against it.
 */
export interface GitPin {
  workTree: string;
  gitDir: string;
  /** The `.git` file's bytes as latin1, so a byte-exact comparison survives JSON. */
  pointer: string;
  /** `skip-worktree <path>` / `assume-unchanged <path>` for entries flagged at creation — a sparse checkout's. */
  flagged: string[];
}

export interface PointerFiles {
  read(path: string): string;
  kind(path: string): "file" | "directory" | "symlink" | "other" | "missing";
  list(dir: string): string[];
  realpath(path: string): string;
}

export const nodePointerFiles: PointerFiles = {
  read: (path) => readFileSync(path, "latin1"),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  },
  kind(path) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isFile()) return "file";
      if (stat.isDirectory()) return "directory";
      return "other";
    } catch {
      return "missing";
    }
  },
};

export function pinnedGitEnv(pin: Pick<GitPin, "workTree" | "gitDir">): NodeJS.ProcessEnv {
  return { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.workTree };
}

function inside(workTree: string, cwd: string): boolean {
  const root = resolve(workTree);
  const at = resolve(cwd);
  return at === root || at.startsWith(`${root}${sep}`);
}

const PINNED_TOOLS = new Set(["git", "gh"]);

/**
 * Every git and gh spawn whose cwd is inside a pinned worktree runs against the pinned git dir.
 *
 * gh is included because it shells out to git for the branch and the remote: through a redirected
 * pointer, `remote.origin.url` is whatever the agent wrote. Nothing else is: a gate's npm or the
 * agent itself seeing `GIT_DIR` would point every repository its tests create at this one.
 */
export function pinGit(runner: Runner, pins: () => Iterable<Pick<GitPin, "workTree" | "gitDir">>): Runner {
  return {
    run(command, args, opts) {
      if (!PINNED_TOOLS.has(basename(command))) return runner.run(command, args, opts);
      for (const pin of pins()) {
        if (inside(pin.workTree, opts.cwd)) {
          return runner.run(command, args, { ...opts, env: { ...(opts.env ?? childEnv()), ...pinnedGitEnv(pin) } });
        }
      }
      return runner.run(command, args, opts);
    },
  };
}

async function flaggedEntries(runner: Runner, gitPath: string, pin: Pick<GitPin, "workTree" | "gitDir">): Promise<string[]> {
  const result = await runner.run(requireGitPath(gitPath), gitArgs(["ls-files", "-v", "-z"]), {
    cwd: pin.workTree,
    timeoutMs: TIMEOUT_MS,
    env: localGitEnv([], pinnedGitEnv(pin)),
  });
  if (result.timedOut) throw new Error(`git ls-files timed out after ${TIMEOUT_MS}ms`);
  if (result.code !== 0) throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  // `S` is skip-worktree; a lowercase tag is assume-unchanged. Either keeps an edit to a tracked
  // file out of `status` and `add --all`.
  return result.stdout
    .split("\0")
    .filter((entry) => entry.length > 2 && (entry[0] === "S" || /[a-z]/.test(entry[0])))
    .map((entry) => `${entry[0] === "S" || entry[0] === "s" ? "skip-worktree" : "assume-unchanged"} ${entry.slice(2)}`);
}

function resolvedFrom(dir: string, text: string, files: PointerFiles): string {
  const named = text.replace(/\n$/, "");
  return files.realpath(isAbsolute(named) ? named : resolve(dir, named));
}

/**
 * The pin for a worktree `git worktree add` just made, derived from the main clone and never from
 * the worktree: its path is reused across attempts, so a process an earlier attempt left behind can
 * rewrite `<workTree>/.git` before anything here reads it. The admin dir is the one under the
 * clone's `worktrees/` whose `gitdir` names this worktree — that file and `commondir` are outside
 * what a confined step can write — and the pointer must already be what git writes for it, in
 * either of git's two spellings (`worktree.useRelativePaths`).
 */
export async function recordPin(
  runner: Runner,
  gitPath: string,
  repoPath: string,
  workTree: string,
  files: PointerFiles = nodePointerFiles,
): Promise<GitPin> {
  const asked = await runner.run(
    requireGitPath(gitPath),
    gitArgs(["rev-parse", "--git-common-dir"]),
    { cwd: repoPath, timeoutMs: TIMEOUT_MS, env: localGitEnv() },
  );
  const answered = asked.stdout.replace(/\n$/, "");
  const named = resolve(repoPath, answered);
  if (asked.code !== 0 || !answered) {
    throw new Error(`could not tell where the clone's git dir is: ${asked.stderr || asked.stdout || "git said nothing"}`);
  }
  const commonDir = files.realpath(named);
  const pointerPath = join(files.realpath(workTree), ".git");

  const admins = files
    .list(join(commonDir, "worktrees"))
    .map((name) => join(commonDir, "worktrees", name))
    .filter((admin) => {
      try {
        return resolvedFrom(admin, files.read(join(admin, "gitdir")), files) === pointerPath &&
          resolvedFrom(admin, files.read(join(admin, "commondir")), files) === commonDir;
      } catch {
        return false;
      }
    });
  if (admins.length !== 1) {
    throw new Error(`the clone at ${repoPath} records ${admins.length} git dirs for the worktree at ${workTree}, not one`);
  }
  const gitDir = admins[0];

  const written = [`gitdir: ${gitDir}\n`, `gitdir: ${relative(dirname(pointerPath), gitDir)}\n`];
  const pointer = files.kind(pointerPath) === "file" ? files.read(pointerPath) : null;
  if (pointer === null || !written.includes(pointer)) {
    throw new Error(
      `refusing the new worktree: its .git file ${pointer === null ? "is missing" : `reads ${quoted(pointer)}`} where git wrote ${quoted(written[0])}`,
    );
  }
  return { workTree, gitDir, pointer, flagged: await flaggedEntries(runner, gitPath, { workTree, gitDir }) };
}

function quoted(text: string): string {
  const shown = JSON.stringify(text.trim());
  return shown.length <= QUOTED_AT_MOST ? shown : `${shown.slice(0, QUOTED_AT_MOST)}…"`;
}

/** What has changed about where git would look since `recordPin`, or null; throws when git cannot list the index. */
export async function pinTampering(
  runner: Runner,
  gitPath: string,
  pin: GitPin,
  files: PointerFiles = nodePointerFiles,
): Promise<string | null> {
  const pointerPath = join(pin.workTree, ".git");
  const kind = files.kind(pointerPath);
  if (kind === "missing" && files.kind(pin.workTree) !== "directory") {
    return `its whole directory removed, ${pin.workTree} included`;
  }
  if (kind !== "file") {
    return kind === "missing"
      ? `its .git file removed, which git wrote as ${quoted(pin.pointer)}`
      : `a ${kind} at .git where git wrote a file reading ${quoted(pin.pointer)}`;
  }
  const now = files.read(pointerPath);
  if (now !== pin.pointer) {
    return `its .git file reading ${quoted(now)} where git wrote ${quoted(pin.pointer)}, which would point git at another repository`;
  }

  const flagged = await flaggedEntries(runner, gitPath, pin);
  const before = new Set(pin.flagged);
  const added = flagged.filter((entry) => !before.has(entry));
  if (added.length === 0) return null;
  const more = added.length > NAMED_AT_MOST ? `, and ${added.length - NAMED_AT_MOST} more` : "";
  return `index flags that hide edits to tracked files from git status and git add: ${added.slice(0, NAMED_AT_MOST).join(", ")}${more}`;
}
