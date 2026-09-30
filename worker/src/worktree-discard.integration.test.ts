import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerConfig } from "./config.js";
import { createRunner } from "./exec.js";
import { createWorkspace } from "./workspace.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.com", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.com" },
  }).toString();
}

/**
 * BP-804. What the worker does to a worktree with its own uid, after a confined process — which may
 * remove its worktree and put a symlink where it was — has had the run. `git worktree remove`
 * deletes by path, so it emptied whatever the symlink pointed at once that held a copy of the
 * pointer file; `worktree add` checked out through a leftover symlink and registered the outside
 * path. Real git; every target is a directory this test made.
 */
describe("the worker's own writes to a worktree a run may have replaced", () => {
  let dir: string;
  let parent: string;
  let root: string;
  let victim: string;

  const workspace = () =>
    createWorkspace(
      { repoPath: parent, worktreeRoot: root, baseBranch: "main" } as WorkerConfig,
      createRunner(),
      gitPath,
      () => ({}),
      join(dir, "origin.git"),
      { name: "worker", email: "worker@example.com" },
    );

  const registered = () =>
    git(parent, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp804-discard-")));
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    writeFileSync(join(seed, "README.md"), "# t\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", origin, parent], { stdio: "pipe" });
    root = join(dir, "wt");
    victim = join(dir, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "precious.txt"), "keep\n");
  });

  afterEach(() => {
    execFileSync("chflags", ["-R", "nouchg,nouappnd", dir]);
    execFileSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes nothing through a worktree swapped for a symlink to a copy of itself", async () => {
    const worktree = await workspace().create("BP-1", "worker");
    copyFileSync(join(worktree.path, ".git"), join(victim, ".git"));
    renameSync(worktree.path, join(dir, "moved-away"));
    symlinkSync(victim, worktree.path);

    await workspace().destroy("BP-1");

    expect(readFileSync(join(victim, "precious.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(victim, ".git"))).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
    expect(registered()).not.toContain(worktree.path);
  });

  it("takes a worktree a step made unwritable, and the next attempt is not wedged by it", async () => {
    const worktree = await workspace().create("BP-1", "worker");
    mkdirSync(join(worktree.path, "d", "e"), { recursive: true });
    writeFileSync(join(worktree.path, "d", "e", "f"), "x\n");
    chmodSync(join(worktree.path, "d", "e"), 0o500);
    chmodSync(worktree.path, 0o500);

    const next = await workspace().create("BP-1", "worker");

    expect(existsSync(worktree.path)).toBe(false);
    expect(registered()).toEqual([realpathSync(parent), next.path]);
    expect(readdirSync(root).filter((name) => name.startsWith(".discard-"))).toEqual([]);
  });

  it.each([
    ["a non-empty directory", () => victim],
    ["nothing", () => join(dir, "dangling")],
    ["a path whose parent is missing", () => join(dir, "missing", "deeper")],
  ])("creates the next attempt over a leftover symlink to %s", async (_, target) => {
    mkdirSync(root, { recursive: true });
    symlinkSync(target(), join(root, "BP-1"));

    const worktree = await workspace().create("BP-1", "worker");

    expect(readFileSync(join(worktree.path, "README.md"), "utf8")).toBe("# t\n");
    expect(readdirSync(victim)).toEqual(["precious.txt"]);
    expect(readdirSync(root)).not.toContain("BP-1");
  });

  it("checks nothing out through a leftover symlink to an empty directory, and registers nothing outside", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    mkdirSync(root, { recursive: true });
    symlinkSync(empty, join(root, "BP-1"));

    const worktree = await workspace().create("BP-1", "worker");

    expect(readdirSync(empty)).toEqual([]);
    expect(registered()).toEqual([realpathSync(parent), worktree.path]);
  });

  // BP-804 review: `worktree prune` unregistered any of the operator's own worktrees whose
  // directory was missing when it ran — an unmounted disk's, say
  it("leaves the operator's own worktree registered while its directory is away", async () => {
    const own = join(dir, "own");
    git(parent, "worktree", "add", "--quiet", "-b", "mine", own, "main");
    const worktree = await workspace().create("BP-1", "worker");
    renameSync(own, join(dir, "own-unmounted"));

    await workspace().destroy("BP-1");
    renameSync(join(dir, "own-unmounted"), own);

    expect(registered()).toEqual([realpathSync(parent), own]);
    expect(git(own, "status", "--porcelain")).toBe("");
    expect(registered()).not.toContain(worktree.path);
  });

  // BP-804 review: `chflags uchg` is a write a confined step may make to its own worktree, and an
  // immutable directory cannot be renamed
  it("creates the next attempt over a worktree a step made immutable", async () => {
    const worktree = await workspace().create("BP-1", "worker");
    writeFileSync(join(worktree.path, "pinned.txt"), "x\n");
    execFileSync("chflags", ["uchg", join(worktree.path, "pinned.txt")]);
    execFileSync("chflags", ["uchg", worktree.path]);

    const next = await workspace().create("BP-1", "worker");

    expect(existsSync(worktree.path)).toBe(false);
    expect(registered()).toEqual([realpathSync(parent), next.path]);
    expect(readdirSync(root).filter((name) => name.startsWith(".discard-"))).toEqual([]);
  });
});
