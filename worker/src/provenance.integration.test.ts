import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unexpectedHistory } from "./provenance.js";
import { createRunner } from "./exec.js";

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

    writeFileSync(join(work, "b.txt"), "planted\n");
    git(work, "add", "b.txt");
    git(work, "commit", "--quiet", "-m", "not tracked by this run");
    const plantedSha = git(work, "rev-parse", "HEAD").trim();

    const reason = await unexpectedHistory(createRunner(), work, baseSha, [ownSha]);

    expect(reason).toContain(plantedSha);
  });
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

    expect(git(work, "rev-list", `${baseSha}..HEAD`).trim().split("\n")).toEqual([ownSha]);
    expect(git(work, "rev-parse", "HEAD").trim()).toBe(ownSha);

    const reason = await unexpectedHistory(createRunner(), work, baseSha, [ownSha]);

    expect(reason).toContain(foreignSha);
  });
});
