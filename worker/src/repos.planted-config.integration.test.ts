import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configBaseline, plantedConfig } from "./repos.js";
import { createRunner } from "./exec.js";

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

  const scan = (baseline?: string[] | null) => plantedConfig(createRunner(), work, baseline);

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

  // The control that matters most, and the one that caught the naive fix: a repository with
  // nothing planted, on a machine whose global config is whatever it is, is not refused.
  it("says nothing about an ordinary checkout", async () => {
    expect(await scan(await configBaseline(createRunner(), work))).toBe("");
  });

  /**
   * The control the naive version of this fix failed, and the reason the baseline exists. Run
   * against this machine's own `~/.gitconfig` rather than the empty one the other cases use:
   * measured while designing this, a normally-configured Mac carries five executable keys in the
   * effective config — an osxkeychain helper and gh's, every one of them legitimate and every one
   * of them a match for the rules below. A scan that judged them would refuse the machine.
   */
  it("says nothing about an ordinary checkout on this machine's real configuration", async () => {
    if (realHome === undefined) return;
    process.env.HOME = realHome;

    expect(await scan(await configBaseline(createRunner(), work))).toBe("");
  });

  it("refuses an include.path as itself, without reading what it points at", async () => {
    const payload = join(dir, "payload.inc");
    writeFileSync(payload, `[credential]\n\thelper = "!sh -c 'touch ${join(dir, "PWNED")}'"\n`);
    git(work, "config", "include.path", payload);

    const said = await scan(await configBaseline(createRunner(), work));

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

    const said = await plantedConfig(createRunner(), linked, await configBaseline(createRunner(), work));
    expect(said).toContain("core.sshcommand");
    expect(said).toContain("worktree");
  });

  it("refuses a global key that appeared after the baseline, and not one that was already there", async () => {
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = /usr/bin/true\n");
    const baseline = await configBaseline(createRunner(), work);

    // The control, and it is the whole reason this is a baseline and not a scope list: the helper
    // that was already on the machine is the operator's, and refusing it would refuse the machine
    expect(await scan(baseline)).toBe("");

    writeFileSync(
      join(home, ".gitconfig"),
      `[credential]\n\thelper = /usr/bin/true\n[core]\n\tsshCommand = touch ${join(dir, "SSH")}\n`
    );

    const said = await scan(baseline);
    expect(said).toContain("core.sshcommand");
    expect(said).toContain("global");
  });

  // Not "so a Git-LFS checkout still commits" — it does not, and has not since bindRepository:
  // filter.lfs.clean is a program git runs. What must not change is the sibling key that is inert.
  it("lets Git-LFS's inert keys through and still refuses its executable one", async () => {
    git(work, "config", "filter.lfs.required", "true");
    git(work, "config", "diff.lfs.cachetextconv", "false");
    const baseline = await configBaseline(createRunner(), work);
    expect(await scan(baseline)).toBe("");

    git(work, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    expect(await scan(baseline)).toContain("filter.lfs.clean");
  });

  it("refuses a directory that is not a checkout, rather than reading the machine as clean", async () => {
    expect(await plantedConfig(createRunner(), dir, [])).toBe("an unreadable git config");
  });
});
