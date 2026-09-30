import { randomBytes } from "crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, isAbsolute, join, resolve } from "path";

const CHFLAGS = "/usr/bin/chflags";
const CHMOD = "/bin/chmod";

/**
 * What the worker does to a worktree with its own, unconfined, uid (BP-804).
 *
 * `git worktree remove` deletes by path and re-resolves it as it goes, so a worktree a leftover
 * confined process swapped for a symlink had git empty the symlink's target. `discard` never hands
 * a path to anything that deletes: it renames the entry beside itself — a symlink moves as a link,
 * and no sandbox rule names the new path — and removes it there, which follows no symlink.
 * `forget` then unregisters exactly the worktrees it is told are ours, where `worktree prune`
 * would also take any other whose directory happens to be missing.
 */
export interface WorktreeDisk {
  names(root: string): string[];
  discard(root: string, path: string): void;
  /** Removes each admin dir under `adminRoot` whose `gitdir` names a worktree `owns` accepts. */
  forget(adminRoot: string, owns: (workTree: string) => boolean): void;
  /** Each attempt's worktree gets a name no earlier attempt's confinement can have named. */
  nonce(): string;
}

export const DISCARDED = ".discard-";

export const nodeWorktreeDisk: WorktreeDisk = {
  names(root) {
    try {
      return readdirSync(root);
    } catch {
      return [];
    }
  },
  discard(root, path) {
    // Beside it rather than into a directory of its own: moving a directory to another parent needs
    // write access to the directory itself, which a confined step can take away with `chmod`. macOS 15
    // refuses even this rename for a directory left at 0500 (EACCES, measured on 15.7.9, where 26.6
    // allows it), so a refusal unlocks it
    // Never throws: a path that will not move stays where it is, and the next attempt's name is
    // a fresh one anyway
    const trash = join(root, `${DISCARDED}${randomBytes(6).toString("hex")}`);
    try {
      renameSync(path, trash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // `chflags uchg` and `chmod` are writes a confined step may make to its own worktree
      clearFlags(path);
      unlock(path);
      try {
        renameSync(path, trash);
      } catch {
        return;
      }
    }
    removeDiscarded(trash);
  },
  forget(adminRoot, owns) {
    for (const name of this.names(adminRoot)) {
      const admin = join(adminRoot, name);
      const workTree = namedWorkTree(admin);
      if (workTree !== null && owns(workTree)) rmSync(admin, { recursive: true, force: true });
    }
  },
  nonce: () => randomBytes(6).toString("hex"),
};

function namedWorkTree(admin: string): string | null {
  try {
    if (!lstatSync(admin).isDirectory()) return null;
    const pointer = join(admin, "gitdir");
    if (!lstatSync(pointer).isFile()) return null;
    const named = readFileSync(pointer, "utf8").replace(/\n$/, "");
    return dirname(isAbsolute(named) ? named : resolve(admin, named));
  } catch {
    return null;
  }
}

// Never throws: the path is already free, and a tree a step made unwritable is retried by the next clear
function removeDiscarded(trash: string): void {
  try {
    rmSync(trash, { recursive: true, force: true });
    return;
  } catch {
    // made unwritable from inside; below
  }
  try {
    clearFlags(trash);
    makeWritable(trash);
    rmSync(trash, { recursive: true, force: true });
  } catch {
    // left for the next clear
  }
}

// -R without -H or -L follows no symlink. `schg` needs root, which a confined step does not have.
function clearFlags(path: string): void {
  try {
    execFileSync(CHFLAGS, ["-R", "nouchg,nouappnd", path], { stdio: "ignore" });
  } catch {
    // what it could not clear, the removal reports by failing
  }
}

// `chmod -h` changes a symlink rather than its target: the entry is still at a path a leftover
// process can swap. Not fs.lchmodSync, which opens the path and fails on a directory with EISDIR.
export function unlock(path: string): void {
  try {
    execFileSync(CHMOD, ["-h", "u+rwx", path], { stdio: "ignore" });
  } catch {
    // the rename that follows reports what is still wrong by failing
  }
}

function makeWritable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}
