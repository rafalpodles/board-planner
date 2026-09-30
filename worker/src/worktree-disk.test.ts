import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlock } from "./worktree-disk.js";

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
