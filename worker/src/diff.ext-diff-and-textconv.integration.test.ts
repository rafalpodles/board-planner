import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";

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

    writeFileSync(join(work, "a.txt"), REAL);
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "implement");

    const externalScript = join(dir, "external.sh");
    writeFileSync(
      externalScript,
      `#!/bin/sh\ntouch "${externalMarker}"\necho "${DECOY.trim()}"\n`
    );
    chmodSync(externalScript, 0o755);
    git(work, "config", "diff.external", externalScript);

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

  it("proves diff.*.textconv is live: an unguarded git diff comes back empty and runs the program", () => {
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
