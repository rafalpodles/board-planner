import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorktreeDisk, removeTree, unlock } from "./worktree-disk.js";

const modeOf = (path: string) => statSync(path).mode & 0o777;

// macOS 15 refuses to rename a directory left at 0500 even within its parent, where 26.6 allows it,
// so the one reachable check on a newer machine is that the unlock itself does what it says
describe("unlock", () => {
  let dir = "";
  afterEach(() => {
    chmodSync(join(dir, "target"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes a directory a step left at 0500 writable again, and follows no symlink doing it", () => {
    dir = mkdtempSync(join(tmpdir(), "bp804-unlock-"));
    mkdirSync(join(dir, "worktree"));
    mkdirSync(join(dir, "target"));
    chmodSync(join(dir, "worktree"), 0o500);
    chmodSync(join(dir, "target"), 0o500);
    symlinkSync(join(dir, "target"), join(dir, "link"));

    unlock(join(dir, "worktree"));
    unlock(join(dir, "link"));

    expect(modeOf(join(dir, "worktree"))).toBe(0o700);
    expect(modeOf(join(dir, "target"))).toBe(0o500);
    expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
  });
});

// BP-985: the home of a project's own commands
describe("a gate home on disk", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is private, and is never an existing directory taken over", () => {
    dir = mkdtempSync(join(tmpdir(), "bp985-disk-"));

    nodeWorktreeDisk.makeDir(join(dir, "home"));

    expect(modeOf(join(dir, "home"))).toBe(0o700);
    expect(() => nodeWorktreeDisk.makeDir(join(dir, "home"))).toThrow(/EEXIST/);
  });

  it("empties with the directory itself kept, read-only trees included, and following no symlink", () => {
    dir = mkdtempSync(join(tmpdir(), "bp985-disk-"));
    const home = join(dir, "home");
    const outside = join(dir, "outside");
    mkdirSync(join(home, "go", "pkg"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "kept"), "x");
    writeFileSync(join(home, "go", "pkg", "mod"), "x");
    chmodSync(join(home, "go", "pkg"), 0o500);
    symlinkSync(outside, join(home, "link"));
    const before = statSync(home).ino;

    nodeWorktreeDisk.empty(home);

    expect(readdirSync(home)).toEqual([]);
    expect(statSync(home).ino).toBe(before);
    expect(existsSync(join(outside, "kept"))).toBe(true);
  });

  it("removes a tree without ever throwing, even one it cannot find", () => {
    dir = mkdtempSync(join(tmpdir(), "bp985-disk-"));

    expect(() => removeTree(join(dir, "gone"))).not.toThrow();
  });
});
