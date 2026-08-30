import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll } from "./commit.js";
import { createRunner } from "./exec.js";

/**
 * BP-403. `filter.<name>.clean` is the write-path twin of the `diff.<driver>.textconv` leaf BP-382
 * closed, reached through the same primitive: `.git/info/attributes`, which git never tracks, which
 * every linked worktree shares with the main clone, and which protected-paths therefore never sees.
 * The agent writes the attribute and the config, and the worker's own `commitAll` is what runs the
 * program — as this process's uid, with this process's environment, and with Bash back underneath
 * an agent this pipeline took Bash away from.
 *
 * Real git against a real repository: the question is what git does with these keys, not whether a
 * mocked runner was handed the right flag spelling.
 */

const BASE = "aaaa\n";
// The same length as BASE on purpose: git reads a file's content — and so runs the filter — only
// when size and stat cannot answer "modified?" on their own, so an equal-size edit is what makes
// `git status` a content read too. The invariant is asserted below rather than left to the reader:
// widening this string by one character silently turns the ordering cases into tests of `git add`
// alone, and they stay green with the guard moved after `status`. Measured.
const EDITED = "bbbb\n";
// A file the agent newly wrote — the ordinary case in this pipeline. `git status` runs the filter
// for an untracked file whatever its size, so this pins the ordering without depending on a length.
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

    // What the agent did during the run, and what the worker is about to stage.
    writeFileSync(join(work, "a.txt"), EDITED);

    // `cat` because a filter that writes nothing back would empty the file and make the refusal
    // look like it was about corruption rather than about execution.
    writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(payload, 0o755);
    // Untracked, shared with the main clone, invisible to protected-paths — the whole point.
    writeFileSync(join(work, ".git", "info", "attributes"), "* filter=z\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Measured, git 2.50.1: `clean` and `process` run when git stages; `smudge` runs on checkout, so
  // staging never reaches it. Asserting "the program did not run" for smudge would therefore pass
  // against the unfixed code too — for that leaf the refusal itself is the whole of the evidence.
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

        // The same ordering, pinned to something no fixture edit can quietly undo: for an untracked
        // file `git status` runs the filter whatever the size, so this fails if the guard moves
        // after `status` even when the equal-size premise above is broken.
        it("never runs the program for a file the agent newly wrote", async () => {
          writeFileSync(join(work, "a.txt"), BASE);
          writeFileSync(join(work, "new.ts"), NEW_FILE);

          await expect(commitAll(createRunner(), work, "BP-403: staged work")).rejects.toThrow();
          expect(existsSync(marker)).toBe(false);
        });
      }
    });
  }

  // The control. Without it a mis-wired fixture — a payload that never had a chance to run, a
  // worktree with nothing staged — would read exactly like a refusal that worked.
  describe("a checkout the agent left alone", () => {
    it("commits, and returns the sha it created", async () => {
      const sha = await commitAll(createRunner(), work, "BP-403: ordinary work");

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(work, "rev-parse", "HEAD").trim()).toBe(sha);
      expect(git(work, "show", "--pretty=format:", "--name-only", "HEAD").trim()).toBe("a.txt");
      expect(existsSync(marker)).toBe(false);
    });

    it("commits with the attribute still in place, so a gitattributes repository is not refused", async () => {
      // `* filter=z` is set by the fixture and stays set here: an attribute naming a filter no
      // config defines is inert, and refusing it would break every ordinary repository.
      git(work, "config", "filter.z.required", "false");

      expect(await commitAll(createRunner(), work, "BP-403: ordinary work")).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
