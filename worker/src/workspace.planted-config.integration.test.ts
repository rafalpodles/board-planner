import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./workspace.js";
import { createRunner } from "./exec.js";

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
    writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(payload, 0o755);
    git(repoPath, "config", "filter.z.smudge", payload);
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

  describe("and a subsection name carrying the separator the scan splits on", () => {
    const FILTER_NAME = "a=b";

    function plantThroughSubsectionName(repoPath: string) {
      writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
      chmodSync(payload, 0o755);
      git(repoPath, "config", `filter.${FILTER_NAME}.smudge`, payload);
      git(repoPath, "config", `filter.${FILTER_NAME}.clean`, "cat");
      writeFileSync(join(repoPath, ".git", "info", "attributes"), `* filter=${FILTER_NAME}\n`);
    }

    it(
      "is a live danger — plain git runs it",
      () => {
        plantThroughSubsectionName(main);

        git(main, "worktree", "add", "-B", "raw", "--", join(dir, "raw"), "HEAD");

        expect(
          existsSync(marker),
          `git ${git(main, "--version").trim()} did not run the filter`
        ).toBe(true);
      },
      REAL_GIT_TIMEOUT_MS
    );

    it(
      "does not run when the worker checks the same tree out",
      async () => {
        plantThroughSubsectionName(main);

        await expect(workspaceFor(main).create("BP-1", "worker")).rejects.toMatchObject({
          name: "PoisonedCheckoutError",
          message: expect.stringContaining("filter.a=b.smudge"),
        });

        expect(existsSync(marker), "the planted filter ran anyway").toBe(false);
      },
      REAL_GIT_TIMEOUT_MS
    );
  });

  it(
    "calls a malformed global config a base it could not resolve, not a poisoned checkout",
    async () => {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".gitconfig"), "[user\nname = broken\n");
      const realHome = process.env.HOME;
      process.env.HOME = home;

      try {
        expect(() => git(main, "config", "--local", "--list")).toThrow();

        await expect(workspaceFor(main).create("BP-1", "worker")).rejects.toMatchObject({
          name: "BaseUnavailableError",
        });
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    },
    REAL_GIT_TIMEOUT_MS
  );

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

  describe("and a key planted in the operator's own HOME rather than the repository", () => {
    let realHome: string | undefined;

    beforeEach(() => {
      const home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
      chmodSync(payload, 0o755);
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
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    });

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

      expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
      expect(existsSync(marker), "the key in ~/.gitconfig ran anyway").toBe(false);
    }, REAL_GIT_TIMEOUT_MS);
  });

  it("still creates the worktree on the same repository with nothing planted", async () => {
    const worktree = await workspaceFor(main).create("BP-1", "worker");

    expect(worktree.path).toBe(join(dir, "cp-worktrees", "BP-1"));
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    expect(worktree.baseSha).toBe(git(main, "rev-parse", "HEAD").trim());
  }, REAL_GIT_TIMEOUT_MS);
});
