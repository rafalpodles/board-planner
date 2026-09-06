import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configBaseline, plantedConfig } from "./repos.js";
import { createRunner } from "./exec.js";

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

    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("names a key whose subsection carries the separator a line-based read would split on", async () => {
    git(work, "config", "filter.a=b.smudge", "/tmp/payload.sh");

    const said = await scan();

    expect(said).toContain("filter.a=b.smudge");
    expect(said).toContain("local");
  });

  it("is not fooled by a newline inside a value", async () => {
    git(work, "config", "user.agent", "one\nfilter.z.smudge=/tmp/payload.sh");

    const said = await scan();

    expect(said, "the value's second line was read as a key of its own").toBe("");
  });

  it("says nothing about an ordinary checkout", async () => {
    expect(await scan(await configBaseline(createRunner(), work))).toBe("");
  });

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
    expect(said).not.toContain("credential.helper");
  });

  it("refuses a key in the per-worktree scope, which --local cannot see", async () => {
    git(work, "config", "extensions.worktreeConfig", "true");
    const linked = join(dir, "linked");
    git(work, "worktree", "add", "--quiet", "--detach", linked);
    execFileSync("git", ["config", "--worktree", "core.sshCommand", "touch /tmp/x"], { cwd: linked, stdio: "pipe" });

    const local = execFileSync("git", ["config", "--local", "--list"], { cwd: linked, encoding: "utf8" });
    expect(local).not.toContain("sshcommand");

    const said = await plantedConfig(createRunner(), linked, await configBaseline(createRunner(), linked));
    expect(said).toContain("core.sshcommand");
    expect(said).toContain("worktree");
  });

  it("refuses a global key that appeared after the baseline, and not one that was already there", async () => {
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = /usr/bin/true\n");
    const baseline = await configBaseline(createRunner(), work);

    expect(await scan(baseline)).toBe("");

    writeFileSync(
      join(home, ".gitconfig"),
      `[credential]\n\thelper = /usr/bin/true\n[core]\n\tsshCommand = touch ${join(dir, "SSH")}\n`
    );

    const said = await scan(baseline);
    expect(said).toContain("core.sshcommand");
    expect(said).toContain("global");
  });

  it("lets Git-LFS's inert keys through and still refuses its executable one", async () => {
    git(work, "config", "filter.lfs.required", "true");
    git(work, "config", "diff.lfs.cachetextconv", "false");
    const baseline = await configBaseline(createRunner(), work);
    expect(await scan(baseline)).toBe("");

    git(work, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    expect(await scan(baseline)).toContain("filter.lfs.clean");
  });

  it("refuses a directory that is not a checkout, rather than reading the machine as clean", async () => {
    const baseline = await configBaseline(createRunner(), dir);

    expect(await plantedConfig(createRunner(), dir, baseline)).toBe("an unreadable git config");
  });
});
