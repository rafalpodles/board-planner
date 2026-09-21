import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantedConfig } from "./repos.js";
import { createRunner } from "./exec.js";
import { gitArgs, localGitEnv, operatorGitEnv } from "./git-safety.js";

/**
 * BP-346. `plantedConfig` read `--local --list`, and three things live outside that scope: an
 * `include.path` whose payload is in another file, the per-worktree scope behind
 * `extensions.worktreeConfig`, and `~/.gitconfig`. Each resolves a program git then runs, as the
 * worker's uid, on a call carrying the push credential.
 *
 * Real git against real repositories, because every claim here is about what git reads and what it
 * hides — a stubbed runner would answer whatever it was told, which is how the gap survived.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@e", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@e" },
  }).toString();
}

describe("plantedConfig against a real repository", () => {
  let dir: string;
  let work: string;
  let home: string;
  let realHome: string | undefined;

  const scan = (cwd = work) => plantedConfig(createRunner(), "git", cwd);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp346-"));
    work = join(dir, "work");
    home = join(dir, "home");
    mkdirSync(home);
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "w@e");
    git(work, "config", "user.name", "w");
    writeFileSync(join(work, "a.txt"), "a\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "base");

    // The child git reads HOME from childEnv's allowlist, so this is how ~/.gitconfig is driven
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    // Assigned back rather than deleted: `delete` then read gives undefined, but assigning an
    // undefined into process.env stores the string "undefined"
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The same key `workspace.planted-config.integration.test.ts` watches git run, asserted here on
   * what the scan itself answers: a subsection name carrying the `=` a line-based read splits on.
   */
  it("names a key whose subsection carries the separator a line-based read would split on", async () => {
    git(work, "config", "filter.a=b.smudge", "/tmp/payload.sh");

    const said = await scan();

    expect(said).toContain("filter.a=b.smudge");
    expect(said).toContain("local");
  });

  // The same shape in the value instead of the key: a newline inside a config value is legal, and
  // a reader that splits the listing into lines reads the tail of one as an entry of its own.
  it("is not fooled by a newline inside a value", async () => {
    git(work, "config", "user.agent", "one\nfilter.z.smudge=/tmp/payload.sh");

    const said = await scan();

    expect(said, "the value's second line was read as a key of its own").toBe("");
  });

  // The control that matters most, and the one that caught the naive fix: a repository with
  // nothing planted, on a machine whose global config is whatever it is, is not refused.
  it("says nothing about an ordinary checkout", async () => {
    expect(await scan()).toBe("");
  });

  /**
   * The control the naive version of this fix failed. Run against this machine's own
   * `~/.gitconfig` rather than the empty one the other cases use: measured while designing this, a
   * normally-configured Mac carries five executable keys in the effective config — an osxkeychain
   * helper and gh's, every one of them legitimate and every one of them a match for the rules
   * below. A scan that judged them would refuse the machine.
   */
  it("says nothing about an ordinary checkout on this machine's real configuration", async () => {
    if (realHome === undefined) return;
    process.env.HOME = realHome;

    expect(await scan()).toBe("");
  });

  it("refuses an include.path as itself, without reading what it points at", async () => {
    const payload = join(dir, "payload.inc");
    writeFileSync(payload, `[credential]\n\thelper = "!sh -c 'touch ${join(dir, "PWNED")}'"\n`);
    git(work, "config", "include.path", payload);

    const said = await scan();

    expect(said).toContain("include.path");
    // Named for what it is, not for what following it would have found — the file's content can be
    // replaced between this scan and the git call that uses it
    expect(said).not.toContain("credential.helper");
  });

  it("refuses a key in the per-worktree scope, which --local cannot see", async () => {
    git(work, "config", "extensions.worktreeConfig", "true");
    const linked = join(dir, "linked");
    git(work, "worktree", "add", "--quiet", "--detach", linked);
    execFileSync("git", ["config", "--worktree", "core.sshCommand", "touch /tmp/x"], { cwd: linked, stdio: "pipe" });

    // The premise, asserted rather than assumed: the scope this reaches is one --local does not
    const local = execFileSync("git", ["config", "--local", "--list"], { cwd: linked, encoding: "utf8" });
    expect(local).not.toContain("sshcommand");

    const said = await scan(linked);
    expect(said).toContain("core.sshcommand");
    expect(said).toContain("worktree");
  });

  /**
   * The scan does not judge `~/.gitconfig`, and this is the half that makes that safe: the git the
   * worker runs does not read it either (BP-516).
   *
   * There used to be a baseline here, dating each machine-scope entry so an operator's own
   * credential helper was not read as evidence while a key that appeared during the run was. It
   * could not see a key planted BEFORE the run — that one was inside the baseline, and every later
   * scan waved it through — and no file in `$HOME` is out of the agent's reach to date it against.
   *
   * The two environments below are the same `git config --get`, and the difference between them is
   * the whole fix. `operatorGitEnv` is the control: without it, "the key is not there" and "git
   * cannot see the key" are indistinguishable, and a typo in the planted config would pass.
   */
  it("neither judges the operator's global config nor lets the worker's git read it", async () => {
    writeFileSync(
      join(home, ".gitconfig"),
      `[credential]\n\thelper = /usr/bin/true\n[core]\n\tsshCommand = touch ${join(dir, "SSH")}\n`
    );

    expect(await scan(), "the machine's own configuration was read as an attack").toBe("");

    const read = (env: NodeJS.ProcessEnv) =>
      createRunner()
        .run("git", gitArgs(["config", "--get", "core.sshCommand"]), { cwd: work, timeoutMs: 30_000, env })
        .then((result) => result.stdout.trim());

    expect(await read(operatorGitEnv()), "the key was never planted").toContain("touch");
    expect(await read(localGitEnv()), "the worker's own git still reads ~/.gitconfig").toBe("");
  });

  // Not "so a Git-LFS checkout still commits" — it does not, and has not since bindRepository:
  // filter.lfs.clean is a program git runs. What must not change is the sibling key that is inert.
  it("lets Git-LFS's inert keys through and still refuses its executable one", async () => {
    git(work, "config", "filter.lfs.required", "true");
    git(work, "config", "diff.lfs.cachetextconv", "false");
    expect(await scan()).toBe("");

    git(work, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    expect(await scan()).toContain("filter.lfs.clean");
  });

  // `--list` alone answers with the machine's config outside a checkout and exits 0, so the
  // readability probe is the only thing that can tell "this is not a repository" from "this
  // repository is clean" (BP-346).
  it("refuses a directory that is not a checkout, rather than reading the machine as clean", async () => {
    expect(await scan(dir)).toBe("an unreadable git config");
  });
});
