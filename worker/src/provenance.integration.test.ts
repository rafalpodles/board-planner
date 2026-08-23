import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unexpectedHistory } from "./provenance.js";
import { createRunner } from "./exec.js";

/**
 * provenance.test.ts proves the comparison logic against a mocked runner that answers to
 * `args.includes("rev-list")` — it never exercises the actual range expression, the `cwd`, or the
 * `gitArgs`/`GIT_SAFE_ENV` wiring. A regression to `rev-list --all`, a dropped `gitArgs`, or a
 * `cwd` pointed at the wrong worktree would stay green there. Real git, real repository, following
 * the convention in diff.replace-refs.integration.test.ts.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("unexpectedHistory against a real repository", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-provenance-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");

    writeFileSync(join(work, "a.txt"), "base\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the range holds exactly the run's own commit", async () => {
    writeFileSync(join(work, "a.txt"), "changed\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "implement");
    const ownSha = git(work, "rev-parse", "HEAD").trim();

    const reason = await unexpectedHistory(createRunner(), work, baseSha, [ownSha]);

    expect(reason).toBe("");
  });

  it("refuses a commit planted straight into the branch, by its sha", async () => {
    writeFileSync(join(work, "a.txt"), "changed\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "implement");
    const ownSha = git(work, "rev-parse", "HEAD").trim();

    // Not something commitAll ever produced — a second real commit landed on the branch the same
    // way an agent with Write under .git (or a stray `git commit` outside the tracked call) could.
    writeFileSync(join(work, "b.txt"), "planted\n");
    git(work, "add", "b.txt");
    git(work, "commit", "--quiet", "-m", "not tracked by this run");
    const plantedSha = git(work, "rev-parse", "HEAD").trim();

    const reason = await unexpectedHistory(createRunner(), work, baseSha, [ownSha]);

    expect(reason).toContain(plantedSha);
  });
  // A graft is one file under .git — refs/replace/<sha> — and it re-parents a commit for every
  // read that walks history. Measured on git 2.50.1: `rev-list <base>..HEAD` reports both commits
  // before `git replace --graft <own> <base>` and only the run's own commit after it, so the
  // foreign commit carrying the payload leaves the range while HEAD still reads back as the sha
  // this run committed. GIT_SAFE_ENV's GIT_NO_REPLACE_OBJECTS is what puts it back; the planted
  // second commit above is caught with or without that variable, so this is the only test here
  // that can tell whether it is still being passed.
  it("refuses a foreign commit hidden behind a replace graft", async () => {
    writeFileSync(join(work, "b.txt"), "planted\n");
    git(work, "add", "b.txt");
    git(work, "commit", "--quiet", "-m", "not tracked by this run");
    const foreignSha = git(work, "rev-parse", "HEAD").trim();

    writeFileSync(join(work, "a.txt"), "changed\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "implement");
    const ownSha = git(work, "rev-parse", "HEAD").trim();

    git(work, "replace", "--graft", ownSha, baseSha);

    // The attack works: without this, a green test would prove only that the graft never took.
    expect(git(work, "rev-list", `${baseSha}..HEAD`).trim().split("\n")).toEqual([ownSha]);
    expect(git(work, "rev-parse", "HEAD").trim()).toBe(ownSha);

    const reason = await unexpectedHistory(createRunner(), work, baseSha, [ownSha]);

    expect(reason).toContain(foreignSha);
  });
});
