import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./workspace.js";
import { createRunner } from "./exec.js";

/**
 * BP-504. BP-403 taught `commitAll` to refuse a checkout whose config carries an executable key,
 * and refusing is all it does: the key lives in the **shared** `<main>/.git/config`, the run is
 * requeued, and the next attempt starts by calling `git worktree add`.
 *
 * That command checks files **out**, and a checkout is where `smudge` runs. So the payload executes
 * inside `workspace.create`, before any gate on that attempt has looked at anything — which is why
 * the guard has to sit ahead of the checkout rather than downstream of the agent.
 *
 * Real git against a real repository, because the claim is about what git does, not about which
 * flags a mocked runner was handed. The first test is the premise the other two rest on: if a
 * future git stops running the filter here, this file should say so rather than quietly becoming a
 * test of nothing.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "worker",
      GIT_AUTHOR_EMAIL: "worker@example.com",
      GIT_COMMITTER_NAME: "worker",
      GIT_COMMITTER_EMAIL: "worker@example.com",
    },
  }).toString();
}

describe("workspace.create against a planted config", () => {
  let dir: string;
  let origin: string;
  let main: string;
  let marker: string;
  let payload: string;

  const workspaceFor = (repoPath: string) =>
    createWorkspace(
      {
        repoPath,
        worktreeRoot: join(dir, "cp-worktrees"),
        baseBranch: "main",
      } as never,
      createRunner(),
      () => process.env,
      origin
    );

  function plant(repoPath: string) {
    // `cat` because a filter that writes nothing back empties the file, and the refusal would then
    // look like it was about corruption rather than about execution.
    writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(payload, 0o755);
    git(repoPath, "config", "filter.z.smudge", payload);
    // Untracked, shared with every linked worktree, invisible to protected-paths — the primitive
    // BP-382 and BP-403 both turn on.
    writeFileSync(join(repoPath, ".git", "info", "attributes"), "* filter=z\n");
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp504-planted-config-"));
    origin = join(dir, "origin.git");
    main = join(dir, "main");
    marker = join(dir, "filter-ran");
    payload = join(dir, "payload.sh");

    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", "--quiet", origin, main], { stdio: "pipe" });
    git(main, "config", "user.email", "worker@example.com");
    git(main, "config", "user.name", "worker");
    writeFileSync(join(main, "a.txt"), "aaaa\n");
    git(main, "add", "a.txt");
    git(main, "commit", "--quiet", "-m", "base");
    git(main, "push", "--quiet", "origin", "main");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The premise. Everything below is about preventing this, so it is asserted rather than assumed:
  // on this git, `git worktree add` runs the planted smudge filter.
  it("git worktree add runs a planted smudge filter, which is the whole danger", () => {
    plant(main);

    git(main, "worktree", "add", "-B", "raw", "--", join(dir, "raw"), "HEAD");

    expect(existsSync(marker), `git ${git(main, "--version").trim()} did not run the filter`).toBe(
      true
    );
  });

  it("refuses, and the payload does not run", async () => {
    plant(main);

    await expect(workspaceFor(main).create("BP-1", "worker")).rejects.toMatchObject({
      name: "PoisonedCheckoutError",
      message: expect.stringContaining("filter.z.smudge"),
    });

    expect(existsSync(marker), "the planted filter ran anyway").toBe(false);
    expect(existsSync(join(dir, "cp-worktrees", "BP-1")), "the worktree was created anyway").toBe(
      false
    );
  });

  // The control, and it is not optional: every assertion above holds for a create() that refused
  // every checkout, and for a fixture whose remote never answered.
  it("still creates the worktree on the same repository with nothing planted", async () => {
    const worktree = await workspaceFor(main).create("BP-1", "worker");

    expect(worktree.path).toBe(join(dir, "cp-worktrees", "BP-1"));
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    expect(worktree.baseSha).toBe(git(main, "rev-parse", "HEAD").trim());
  });
});
