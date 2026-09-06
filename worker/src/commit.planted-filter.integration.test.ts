import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll } from "./commit.js";
import { createRunner } from "./exec.js";

const BASE = "aaaa\n";
const EDITED = "bbbb\n";
const NEW_FILE = "something the agent wrote, of a length nobody has to keep equal to anything\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "worker", GIT_AUTHOR_EMAIL: "worker@example.com" },
  }).toString();
}

describe("commitAll against a planted filter", () => {
  it("keeps the equal-size premise the ordering cases rest on", () => {
    expect(EDITED.length).toBe(BASE.length);
  });

  let dir: string;
  let work: string;
  let marker: string;
  let payload: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp403-planted-filter-"));
    work = join(dir, "work");
    marker = join(dir, "filter-ran");
    payload = join(dir, "payload.sh");

    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");
    writeFileSync(join(work, "a.txt"), BASE);
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "base");

    writeFileSync(join(work, "a.txt"), EDITED);

    writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(payload, 0o755);
    writeFileSync(join(work, ".git", "info", "attributes"), "* filter=z\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const RUNS_WHEN_STAGING: Record<string, boolean> = { clean: true, process: true, smudge: false };

  for (const leaf of ["clean", "process", "smudge"]) {
    describe(`filter.z.${leaf}`, () => {
      beforeEach(() => {
        git(work, "config", `filter.z.${leaf}`, payload);
      });

      if (RUNS_WHEN_STAGING[leaf]) {
        it("is live: an unguarded git add runs the program", () => {
          git(work, "add", "--all", "--");
          expect(existsSync(marker)).toBe(true);
        });
      }

      it("makes commitAll refuse, and no commit is created", async () => {
        const head = git(work, "rev-parse", "HEAD").trim();

        await expect(commitAll(createRunner(), work, "BP-403: staged work")).rejects.toThrow(
          new RegExp(`refusing to stage.*filter\\.z\\.${leaf}`)
        );

        expect(git(work, "rev-parse", "HEAD").trim()).toBe(head);
      });

      if (RUNS_WHEN_STAGING[leaf]) {
        it("never runs the program — not at add, and not at the status before it", async () => {
          await expect(commitAll(createRunner(), work, "BP-403: staged work")).rejects.toThrow();
          expect(existsSync(marker)).toBe(false);
        });

        it("never runs the program for a file the agent newly wrote", async () => {
          writeFileSync(join(work, "a.txt"), BASE);
          writeFileSync(join(work, "new.ts"), NEW_FILE);

          await expect(commitAll(createRunner(), work, "BP-403: staged work")).rejects.toThrow();
          expect(existsSync(marker)).toBe(false);
        });
      }
    });
  }

  describe("a checkout the agent left alone", () => {
    it("commits, and returns the sha it created", async () => {
      const sha = await commitAll(createRunner(), work, "BP-403: ordinary work");

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(work, "rev-parse", "HEAD").trim()).toBe(sha);
      expect(git(work, "show", "--pretty=format:", "--name-only", "HEAD").trim()).toBe("a.txt");
      expect(existsSync(marker)).toBe(false);
    });

    it("commits with the attribute still in place, so a gitattributes repository is not refused", async () => {
      git(work, "config", "filter.z.required", "false");

      expect(await commitAll(createRunner(), work, "BP-403: ordinary work")).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
