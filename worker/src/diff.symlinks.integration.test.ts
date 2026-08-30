import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";

/**
 * BP-509. Real git, because the claim is about what `--numstat` can and cannot express — and the
 * answer is what made this invisible: a symlink and a one-line text file are the same three fields.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "w",
      GIT_AUTHOR_EMAIL: "w@e",
      GIT_COMMITTER_NAME: "w",
      GIT_COMMITTER_EMAIL: "w@e",
    },
  }).toString();
}

describe("collectDiff and the symlinks a change adds", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp509-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "w@e");
    git(work, "config", "user.name", "w");
    mkdirSync(join(work, "docs"));
    writeFileSync(join(work, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(work, "docs", "g.md"), "g\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();

    symlinkSync("/etc/passwd", join(work, "outside"));
    symlinkSync("../a.ts", join(work, "docs", "up"));
    symlinkSync("./g.md", join(work, "docs", "beside"));
    writeFileSync(join(work, "plain.txt"), "one line\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "the change");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * The premise the whole ticket rests on, asserted on its own so a failure here reads as "git
   * changed" rather than "the gate changed": the four paths are indistinguishable in numstat.
   */
  it("cannot be told from a one-line text file by the numbers alone", () => {
    const numstat = git(work, "diff", "--numstat", baseSha, "HEAD", "--").trim().split("\n");

    expect(numstat).toHaveLength(4);
    for (const line of numstat) expect(line.startsWith("1\t0\t")).toBe(true);
  });

  it("reports each symlink with its target, and the plain file as neither", async () => {
    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.symlinks).toEqual(
      expect.arrayContaining([
        { path: "outside", target: "/etc/passwd" },
        { path: "docs/up", target: "../a.ts" },
        { path: "docs/beside", target: "./g.md" },
      ])
    );
    expect(diff.symlinks).toHaveLength(3);
    // The control: the file that is genuinely one line of text is not among them, while still
    // being in changedFiles like everything else
    expect(diff.symlinks.map((s) => s.path)).not.toContain("plain.txt");
    expect(diff.changedFiles).toContain("plain.txt");
  });

  /**
   * The rename form. `--raw` prints two paths for an `R` status, and the destination is the last —
   * the one that exists after the change. Nothing asserted that until the BP-509 review mutated
   * `paths[paths.length - 1]` to `paths[0]` and watched the suite stay green.
   */
  it("takes the destination path when a symlink is renamed, not the source", async () => {
    git(work, "mv", "outside", "moved");
    git(work, "commit", "--quiet", "-m", "rename it");

    const diff = await collectDiff(createRunner(), work, baseSha);

    expect(diff.symlinks.map((s) => s.path)).toContain("moved");
    expect(diff.symlinks.map((s) => s.path)).not.toContain("outside");
  });

  it("says a change with no symlink has none, rather than leaving the field undefined", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "bp509-plain-"));
    const plain = join(dir2, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", plain], { stdio: "pipe" });
    git(plain, "config", "user.email", "w@e");
    git(plain, "config", "user.name", "w");
    writeFileSync(join(plain, "a.ts"), "1\n");
    git(plain, "add", "-A");
    git(plain, "commit", "--quiet", "-m", "base");
    const base = git(plain, "rev-parse", "HEAD").trim();
    writeFileSync(join(plain, "a.ts"), "2\n");
    git(plain, "add", "-A");
    git(plain, "commit", "--quiet", "-m", "edit");

    expect((await collectDiff(createRunner(), plain, base)).symlinks).toEqual([]);
    rmSync(dir2, { recursive: true, force: true });
  });
});
