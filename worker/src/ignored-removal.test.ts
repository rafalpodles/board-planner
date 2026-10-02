import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFromWorktree } from "./ignored-removal.js";

describe("removing ignored files a step wrote (BP-795)", () => {
  let dir: string;
  let worktree: string;
  let outside: string;
  let secret: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp795-removal-")));
    worktree = join(dir, "worktree");
    outside = join(dir, "outside");
    secret = join(outside, "secret.txt");
    mkdirSync(worktree);
    mkdirSync(outside);
    writeFileSync(secret, "keep\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes a file and a real directory the listing names", () => {
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "evil.test.js"), "");
    mkdirSync(join(worktree, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "dep", "index.js"), "");

    const removal = removeFromWorktree(worktree, ["dist/evil.test.js", "node_modules/dep/"]);

    expect(removal).toEqual({ removed: ["dist/evil.test.js", "node_modules/dep/"], refused: [] });
    expect(existsSync(join(worktree, "dist", "evil.test.js"))).toBe(false);
    expect(existsSync(join(worktree, "node_modules", "dep"))).toBe(false);
  });

  it("unlinks a symlink to a file outside, never its target", () => {
    symlinkSync(secret, join(worktree, "link"));

    expect(removeFromWorktree(worktree, ["link"]).removed).toEqual(["link"]);
    expect(lstatSync(join(worktree, "link"), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(secret)).toBe(true);
  });

  it("unlinks a symlink to a directory outside without entering it", () => {
    symlinkSync(outside, join(worktree, "linked"));

    expect(removeFromWorktree(worktree, ["linked/"]).removed).toEqual(["linked/"]);
    expect(existsSync(secret)).toBe(true);
  });

  it("leaves what a symlink inside a removed directory points at", () => {
    mkdirSync(join(worktree, "node_modules", "dep"), { recursive: true });
    symlinkSync(outside, join(worktree, "node_modules", "dep", "out"));

    expect(removeFromWorktree(worktree, ["node_modules/dep/"]).refused).toEqual([]);
    expect(existsSync(secret)).toBe(true);
  });

  it("refuses a path through a symlinked parent directory", () => {
    symlinkSync(outside, join(worktree, "dist"));

    const removal = removeFromWorktree(worktree, ["dist/secret.txt"]);

    expect(removal.removed).toEqual([]);
    expect(removal.refused[0]).toMatch(/^dist\/secret\.txt \(dist is not a directory of the worktree's own\)/);
    expect(existsSync(secret)).toBe(true);
  });

  it.each([
    ["../outside/secret.txt", "not a plain relative path"],
    ["dist/../../outside/secret.txt", "not a plain relative path"],
    ["<dir>/outside/secret.txt", "an absolute path"],
    [".git/config", "inside a .git"],
    ["sub/.GIT/HEAD", "inside a .git"],
  ])("refuses %s", (path, why) => {
    mkdirSync(join(worktree, "dist"));
    const removal = removeFromWorktree(worktree, [path.replace("<dir>", dir)]);

    expect(removal.removed).toEqual([]);
    expect(removal.refused[0]).toContain(`(${why})`);
    expect(existsSync(secret)).toBe(true);
  });

  it("refuses everything when the worktree itself is a symlink", () => {
    const linked = join(dir, "linked-worktree");
    symlinkSync(outside, linked);

    const removal = removeFromWorktree(linked, ["secret.txt"]);

    expect(removal.removed).toEqual([]);
    expect(existsSync(secret)).toBe(true);
  });
});
