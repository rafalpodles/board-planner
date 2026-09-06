import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Real clones, fetches and checkouts, on a machine that also runs other work. The house pattern
// (wiring.integration.test.ts) is an explicit budget rather than the 5s default.
const REAL_GIT_TIMEOUT_MS = 30_000;

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
  }, REAL_GIT_TIMEOUT_MS);

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
  }, REAL_GIT_TIMEOUT_MS);

  /**
   * The scan reads the repository's own scopes. `$HOME` is not one of them — and it does not have
   * to be planted through the repository at all: `childEnv()` allowlists HOME because the CLI
   * authenticates from its session there, and BP-349 says the agent's Write reaches it. So a
   * `[filter "z"] smudge` in `~/.gitconfig` plus `* filter=z` in `~/.config/git/attributes` made
   * `git worktree add` run the payload with **nothing planted inside the repository**, which the
   * scan by itself cannot see and never will.
   *
   * What closes it is not a wider scan but `GIT_CONFIG_GLOBAL=/dev/null` on these calls — the
   * pattern delivery.ts already uses. A filter has to be DEFINED somewhere, and with the global
   * file out of the picture the only scopes left are the ones the scan reads.
   */
  describe("and a key planted in the operator's own HOME rather than the repository", () => {
    let realHome: string | undefined;

    beforeEach(() => {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
      chmodSync(payload, 0o755);
      // Both halves named by the global config itself — the filter and the attributes file that
      // selects it. The XDG default (`~/.config/git/attributes`) is not used on purpose: git reads
      // `$XDG_CONFIG_HOME/git/attributes` when that variable is set, which it is on CI, so a
      // fixture relying on the default is a fixture that quietly stops planting anything. The
      // premise arm below caught exactly that, having passed on the machine it was written on.
      const attributes = join(home, "attributes");
      writeFileSync(
        join(home, ".gitconfig"),
        `[filter "z"]\n\tsmudge = ${payload}\n[core]\n\tattributesFile = ${attributes}\n`
      );
      writeFileSync(attributes, "* filter=z\n");
      realHome = process.env.HOME;
      process.env.HOME = home;
    });

    afterEach(() => {
      // Assigned back only when there was one: `process.env.X = undefined` stores the string
      // "undefined", which is worse than the variable being absent.
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    });

    // The premise, measured rather than assumed, and the control for the test below it: with the
    // same HOME and a plain `git worktree add`, the payload runs.
    it("is a live danger — plain git runs it, with nothing in the repository", () => {
      execFileSync("git", ["worktree", "add", "-B", "raw", "--", join(dir, "raw"), "HEAD"], {
        cwd: main,
        stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
      });

      expect(existsSync(marker)).toBe(true);
    }, REAL_GIT_TIMEOUT_MS);

    it("does not run when the worker checks the same tree out", async () => {
      const worktree = await workspaceFor(main).create("BP-1", "worker");

      // It succeeds: nothing is planted in the repository, so there is nothing to refuse — the
      // checkout simply does not read the file the key is in.
      expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
      expect(existsSync(marker), "the key in ~/.gitconfig ran anyway").toBe(false);
    }, REAL_GIT_TIMEOUT_MS);
  });

  // The control, and it is not optional: every assertion above holds for a create() that refused
  // every checkout, and for a fixture whose remote never answered.
  it("still creates the worktree on the same repository with nothing planted", async () => {
    const worktree = await workspaceFor(main).create("BP-1", "worker");

    expect(worktree.path).toBe(join(dir, "cp-worktrees", "BP-1"));
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    expect(worktree.baseSha).toBe(git(main, "rev-parse", "HEAD").trim());
  }, REAL_GIT_TIMEOUT_MS);
});
