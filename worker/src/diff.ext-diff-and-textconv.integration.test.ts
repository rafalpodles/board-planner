import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";

/**
 * diff.external (a repo-wide git config key) and diff.<driver>.textconv (a per-path attribute,
 * set in .git/info/attributes — itself untracked, shared with the main clone, and invisible to
 * protected-paths the same way .git/config is) both let something other than git decide what a
 * `git diff` prints. Both are plantable by an agent holding Write under .git in a linked
 * worktree, and both close over an arbitrary program: the review gate would read that program's
 * output instead of the change, and the program runs — Bash back under an agent this pipeline
 * took Bash away from — before every gate's verdict.
 *
 * Real git against a real repository: the question is what git actually does with these two
 * config keys, not whether a mocked runner was handed the right flag spelling.
 */

const REAL = "the real change\n";
const DECOY = "DECOY-CONTENT\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("collectDiff against a planted diff.external and diff.*.textconv", () => {
  let dir: string;
  let work: string;
  let baseSha: string;
  // Where each planted program proves it ran, distinct per program so one cannot be mistaken for
  // the other.
  let externalMarker: string;
  let textconvMarker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp382-ext-textconv-"));
    work = join(dir, "work");
    externalMarker = join(dir, "external-ran");
    textconvMarker = join(dir, "textconv-ran");

    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");

    writeFileSync(join(work, "a.txt"), "base\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();

    // The real change this run made — what delivery.push sends and what a gate has to review.
    writeFileSync(join(work, "a.txt"), REAL);
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "implement");

    // diff.external: a program that replaces the whole patch git would print, wherever it is
    // asked for one — planted the way an agent with Write under .git could, in .git/config.
    const externalScript = join(dir, "external.sh");
    writeFileSync(
      externalScript,
      `#!/bin/sh\ntouch "${externalMarker}"\necho "${DECOY.trim()}"\n`
    );
    chmodSync(externalScript, 0o755);
    git(work, "config", "diff.external", externalScript);

    // diff.<driver>.textconv: the sibling leaf, reached through a per-path attribute instead of
    // the blanket repo-wide setting above — planted in .git/info/attributes, which git never
    // tracks and protected-paths never sees.
    const textconvScript = join(dir, "textconv.sh");
    writeFileSync(
      textconvScript,
      `#!/bin/sh\ntouch "${textconvMarker}"\necho "${DECOY.trim()}"\n`
    );
    chmodSync(textconvScript, 0o755);
    git(work, "config", "diff.attack.textconv", textconvScript);
    writeFileSync(join(work, ".git", "info", "attributes"), "a.txt diff=attack\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("proves diff.external is live: an unguarded git diff shows the decoy and runs the program", () => {
    const patch = execFileSync("git", ["diff", baseSha, "HEAD"], { cwd: work }).toString();

    expect(patch).toContain(DECOY.trim());
    expect(patch).not.toContain(REAL.trim());
    expect(existsSync(externalMarker)).toBe(true);
  });

  it("collectDiff reports the real patch and never runs diff.external", async () => {
    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.patch).toContain(REAL.trim());
    expect(diff.patch).not.toContain(DECOY.trim());
    expect(existsSync(externalMarker)).toBe(false);
  });

  // Measured: the driver here ignores which blob it was handed and always prints the same decoy,
  // so old and new convert to identical text and git reports no difference at all — an empty
  // patch, not a decoy one. That is the actual production shape of this defect: the review gate
  // sees nothing to object to, while the program still ran with a shell underneath it.
  it("proves diff.*.textconv is live: an unguarded git diff comes back empty and runs the program", () => {
    // diff.external takes precedence when both are set, so this program's liveness is proved on
    // its own with diff.external unset for this one call.
    const patch = execFileSync("git", ["diff", "--no-ext-diff", baseSha, "HEAD"], {
      cwd: work,
    }).toString();

    expect(patch).toBe("");
    expect(existsSync(textconvMarker)).toBe(true);
  });

  it("collectDiff reports the real patch and never runs diff.*.textconv", async () => {
    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.patch).toContain(REAL.trim());
    expect(diff.patch).not.toContain(DECOY.trim());
    expect(existsSync(textconvMarker)).toBe(false);
  });
});
