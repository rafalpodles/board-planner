import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, childEnv } from "./env.js";
import { GIT_SAFE_ENV } from "./git-safety.js";
import { CommandResult, createRunner, RunOpts, Runner } from "./exec.js";
import { createWorkspace } from "./workspace.js";
import { collectDiff } from "./diff.js";
import { commitAll } from "./commit.js";
import { createDelivery, hardenedGitConfig } from "./delivery.js";
import { runPreflight } from "./preflight.js";
import { WorkerConfig } from "./config.js";

/**
 * `child-env.contract.test.ts` is a source scan: it cannot see a key that arrives already inside an
 * object — `...deps.env` reads nothing like `...process.env` — or a call site that widens
 * `childEnv`'s `alsoAllow` with a name that should never leave this process. Both are the bypasses
 * BP-310's audit ranked most plausible. This is the runtime half: one shared, recording `Runner`
 * driven through the real functions a task's pipeline actually calls — workspace creation, diffing,
 * a commit, a push, and preflight — against a real git daemon, asserting every env any of them
 * actually built stays inside what the real building blocks are known to add.
 *
 * The permitted set is derived from those building blocks (`ALLOWED`, `GIT_SAFE_ENV`,
 * `hardenedGitConfig()`) rather than hand-copied, so it tracks them if they change; the handful of
 * per-call-site extras (GIT_DIR, the identity keys, delivery's five) are named once here because
 * they live as inline literals in their call sites, not as an exported constant.
 */

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = tcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const KNOWN_EXTRAS = [
  ...Object.keys(GIT_SAFE_ENV), // GIT_CONFIG_NOSYSTEM, GIT_NO_REPLACE_OBJECTS
  "GIT_CONFIG_GLOBAL", // localGitEnv's own addition (git-safety.ts)
  "GIT_DIR", "GIT_CEILING_DIRECTORIES", // workspace.ts's neutral base-lookup env
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", // commit.ts
  "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", // delivery.ts's alsoAllow
  ...Object.keys(hardenedGitConfig()), // delivery.ts's git hardening
];
const PERMITTED = new Set<string>([...ALLOWED, ...KNOWN_EXTRAS]);
const gitPath = "git";

interface RecordedCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function recordingRunner(calls: RecordedCall[]): Runner {
  const real = createRunner();
  return {
    run(command: string, args: string[], opts: RunOpts): Promise<CommandResult> {
      calls.push({ command, args, env: opts.env ?? childEnv() });
      return real.run(command, args, opts);
    },
  };
}

function assertEveryCallStaysInsideTheAllowlist(calls: RecordedCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const unexpected = Object.keys(call.env).filter((key) => !PERMITTED.has(key));
    expect(
      unexpected,
      `${call.command} ${call.args.join(" ")} carried ${JSON.stringify(unexpected)}, ` +
        `outside the allowlist and every known extra`,
    ).toEqual([]);
  }
}

describe("every real env-building call site stays inside the allowlist, across a real run", () => {
  let dir: string;
  let daemon: ChildProcess;
  let remoteUrl: string;
  let parent: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bp310-child-env-"));
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });

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
        "--enable=receive-pack",
        `--base-path=${dir}`,
        `--port=${port}`,
        "--listen=127.0.0.1",
        dir,
      ],
      { stdio: "pipe" },
    );
    // Same grace window delivery.hooks.integration.test.ts uses: the daemon has to be listening
    // before the clone below dials it.
    await new Promise((resolve) => setTimeout(resolve, 700));

    remoteUrl = `git://127.0.0.1:${port}/origin.git`;
    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", remoteUrl, parent], { stdio: "pipe" });
    git(parent, "config", "user.email", "worker@example.com");
    git(parent, "config", "user.name", "worker");
  });

  afterEach(() => {
    daemon.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "workspace creation, diffing, a commit and a push never build an env outside the allowlist",
    async () => {
      const calls: RecordedCall[] = [];
      const runner = recordingRunner(calls);
      const config = {
        repoPath: parent,
        worktreeRoot: join(dir, "wt"),
        baseBranch: "main",
      } as WorkerConfig;

      const workspace = createWorkspace(config, runner, gitPath, () => ({}), remoteUrl);
      const worktree = await workspace.create("BP-1", "worker");

      writeFileSync(join(worktree.path, "change.txt"), "hello\n");
      const sha = await commitAll(runner, gitPath, worktree.path, "a change", worktree.commitIdentity);
      expect(sha).not.toBe("");

      const diff = await collectDiff(runner, gitPath, worktree.path, worktree.baseSha);
      expect(diff.changedFiles).toContain("change.txt");

      await createDelivery(runner, gitPath, config.baseBranch).push(worktree.path, "bp-310/child-env-test", sha);
      const pushed = execFileSync("git", ["ls-remote", remoteUrl, "refs/heads/bp-310/child-env-test"], {
        encoding: "utf8",
      });
      expect(pushed).toContain(sha);

      assertEveryCallStaysInsideTheAllowlist(calls);
    },
  );

  // preflight.ts's `runPreflight` is BP-310's #2-ranked bypass: `wiring.ts` threads `process.env`
  // into `PreflightDeps.env`, and `...childEnv([], deps.env)` becoming `...deps.env` would leak it
  // whole. `deps.env` here is the real `process.env` for exactly that reason — a sandboxed test
  // machine's own environment already carries plenty the allowlist does not (SHLVL, PWD, and the
  // rest), so a leak has every chance to be caught rather than accidentally matching by coincidence.
  it("preflight never builds an env outside the allowlist", async () => {
    const calls: RecordedCall[] = [];
    const runner = recordingRunner(calls);

    await runPreflight({
      runner,
      env: process.env,
      execPath: process.execPath,
      isExecutable: () => true,
    });

    assertEveryCallStaysInsideTheAllowlist(calls);
  });
});
