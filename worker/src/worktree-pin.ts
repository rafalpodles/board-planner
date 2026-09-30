import { lstatSync, readFileSync } from "fs";
import { basename, isAbsolute, join, resolve, sep } from "path";
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
 * main clone's `.git/worktrees/<name>/`, which the step cannot write.
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
}

export const nodePointerFiles: PointerFiles = {
  read: (path) => readFileSync(path, "latin1"),
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

/** Read right after `git worktree add`, while the pointer is still the one git wrote. */
export async function recordPin(
  runner: Runner,
  gitPath: string,
  workTree: string,
  files: PointerFiles = nodePointerFiles,
): Promise<GitPin> {
  const resolved = await runner.run(requireGitPath(gitPath), gitArgs(["rev-parse", "--absolute-git-dir"]), {
    cwd: workTree,
    timeoutMs: TIMEOUT_MS,
    env: localGitEnv(),
  });
  const gitDir = resolved.stdout.trim();
  if (resolved.code !== 0 || !isAbsolute(gitDir)) {
    throw new Error(`could not tell where the new worktree's git dir is: ${resolved.stderr || resolved.stdout || "git said nothing"}`);
  }
  const pointerPath = join(workTree, ".git");
  if (files.kind(pointerPath) !== "file") {
    throw new Error(`the new worktree has no .git file at ${pointerPath}`);
  }
  const pointer = files.read(pointerPath);
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
