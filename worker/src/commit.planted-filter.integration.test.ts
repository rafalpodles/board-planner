import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Required since BP-516; what this file is about is the config, so the identity is a constant.
const IDENTITY = { name: "worker", email: "worker@example.com" };
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

        await expect(commitAll(createRunner(), work, "BP-403: staged work", IDENTITY)).rejects.toThrow(
          new RegExp(`refusing to stage.*filter\\.z\\.${leaf}`)
        );

        expect(git(work, "rev-parse", "HEAD").trim()).toBe(head);
      });

      if (RUNS_WHEN_STAGING[leaf]) {
        it("never runs the program — not at add, and not at the status before it", async () => {
          await expect(commitAll(createRunner(), work, "BP-403: staged work", IDENTITY)).rejects.toThrow();
          expect(existsSync(marker)).toBe(false);
        });

        // The same ordering, pinned to something no fixture edit can quietly undo: for an untracked
        // file `git status` runs the filter whatever the size, so this fails if the guard moves
        // after `status` even when the equal-size premise above is broken.
        it("never runs the program for a file the agent newly wrote", async () => {
          writeFileSync(join(work, "a.txt"), BASE);
          writeFileSync(join(work, "new.ts"), NEW_FILE);

          await expect(commitAll(createRunner(), work, "BP-403: staged work", IDENTITY)).rejects.toThrow();
          expect(existsSync(marker)).toBe(false);
        });
      }
    });
  }

  /**
   * BP-516. The same filter, defined where BP-403's scan was never going to look: the operator's
   * own `~/.gitconfig`. `childEnv()` forwards HOME because the agent CLI authenticates from its
   * session there, and BP-349 says the agent's Write reaches it — so this needs nothing planted
   * inside the repository at all, and the local-scope scan in front of the staging is looking at
   * the wrong file.
   *
   * The answer is not a refusal: there is nothing here to refuse, and an operator's global config
   * is their own. It is that the git doing the staging does not read that file, so the commit goes
   * through with the filter never applied.
   */
  describe("and the filter defined in the operator's own HOME", () => {
    let home: string;
    let realHome: string | undefined;

    beforeEach(() => {
      home = join(dir, "home");
      mkdirSync(home, { recursive: true });
      // Rewrites the content instead of passing it through, so "the filter did not run" is
      // asserted twice over: by the marker, and by what ends up in the commit. With `cat` the
      // second assertion holds whether or not the filter ran, which is no assertion at all.
      writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\necho FILTERED\n`);
      chmodSync(payload, 0o755);
      writeFileSync(join(home, ".gitconfig"), `[filter "z"]\n\tclean = ${payload}\n`);
      realHome = process.env.HOME;
      process.env.HOME = home;
    });

    afterEach(() => {
      // Assigned back rather than deleted: assigning an undefined stores the string "undefined"
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    });

    // The premise. Without it the assertion below is "a filter that could never have run did not
    // run", which is green against the unfixed code and against a typo in the fixture alike.
    it("is live: an unguarded git add runs the program, with nothing in the repository", () => {
      execFileSync("git", ["add", "--all", "--"], { cwd: work, stdio: "pipe", env: { ...process.env, HOME: home } });

      expect(existsSync(marker)).toBe(true);
      // And it decided what got staged, which is the half the marker does not show
      expect(git(work, "show", ":a.txt")).toBe("FILTERED\n");
    });

    it("never runs it when the worker stages, and still commits", async () => {
      const sha = await commitAll(createRunner(), work, "BP-516: staged work", IDENTITY);

      expect(existsSync(marker), "the global filter ran anyway").toBe(false);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(work, "rev-parse", "HEAD").trim()).toBe(sha);
    });

    /**
     * The other half of what that file could decide, and the one that costs an operator something:
     * `core.excludesFile` hides a path from `git status` and from `git add --all` alike. Measured —
     * a file it names is invisible to both, so the worktree reads clean, the change never reaches a
     * diff or a gate, and `npm test` runs it all the same. With the global config out of the
     * picture the file is ordinary work again: staged, committed, reviewable.
     *
     * What it costs is the same sentence read the other way: a `.DS_Store` an operator ignores
     * globally is now committed by the worker, because the repository's own `.gitignore` is the
     * only ignore list left. Stated in worker/README.md rather than worked around — an ignore list
     * that lives outside the repository cannot decide what a machine commits into it.
     */
    it("stages a file the operator's global excludes would have hidden", async () => {
      writeFileSync(join(home, "ignore"), "hidden.ts\n");
      writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "ignore")}\n`);
      writeFileSync(join(work, "hidden.ts"), "what the agent wrote\n");

      // The premise: plain git, reading that file, says the tree is clean apart from the edit
      const seen = execFileSync("git", ["status", "--porcelain"], {
        cwd: work,
        env: { ...process.env, HOME: home },
      }).toString();
      expect(seen).not.toContain("hidden.ts");

      await commitAll(createRunner(), work, "BP-516: staged work", IDENTITY);

      expect(git(work, "show", "--pretty=format:", "--name-only", "HEAD")).toContain("hidden.ts");
    });

    // And what it committed is the file as the agent left it. A `clean` filter rewrites content on
    // the way into the index, so "the program did not run" and "the content is what was written"
    // are two claims, and the second is the one a reviewer of the pull request depends on.
    it("commits what the agent wrote, not what the filter would have made of it", async () => {
      await commitAll(createRunner(), work, "BP-516: staged work", IDENTITY);

      expect(git(work, "show", "HEAD:a.txt")).toBe(EDITED);
    });
  });

  /**
   * The other way a checkout makes `git commit` run a program, and it is not a filter: with
   * `commit.gpgsign` on, git runs `gpg.program` to sign — measured on git 2.50.1 under exactly the
   * worker's environment, and neither key was in any list this module scans (BP-516 review).
   *
   * Two answers, and they cover different halves. The scan names the key when it is in the
   * checkout, which is what bind time reads as an approval since BP-517. `gitArgs` turns signing
   * off at the command line, which is what holds when the key is somewhere the scan does not read —
   * the operator's own `~/.gitconfig` — and for a key nobody has thought of yet.
   */
  describe("and a signing program", () => {
    beforeEach(() => {
      writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
      chmodSync(payload, 0o755);
      // Nothing to do with filters: this checkout has no attributes file of its own
      writeFileSync(join(work, ".git", "info", "attributes"), "");
      git(work, "config", "commit.gpgsign", "true");
    });

    it("is live: an unguarded git commit runs the program", () => {
      git(work, "config", "gpg.program", payload);
      execFileSync("git", ["add", "--all", "--"], { cwd: work, stdio: "pipe" });

      expect(() =>
        execFileSync("git", ["commit", "-m", "signed"], { cwd: work, stdio: "pipe" }),
      ).toThrow();
      expect(existsSync(marker)).toBe(true);
    });

    it("is named by the scan when it is in the checkout, the way a filter is", async () => {
      git(work, "config", "gpg.program", payload);

      await expect(commitAll(createRunner(), work, "BP-516: staged work", IDENTITY)).rejects.toThrow(
        /refusing to stage.*gpg\.program/,
      );
      expect(existsSync(marker)).toBe(false);
    });

    // Where the scan cannot see it — the operator's own file — the commit is what holds: signing is
    // off at the command line, so there is nothing for a signing program to be run by.
    it("is not run from the operator's own config either, and the commit lands", async () => {
      const home = join(dir, "gpg-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".gitconfig"), `[gpg]\n\tprogram = ${payload}\n`);
      const realHome = process.env.HOME;
      process.env.HOME = home;

      try {
        // The premise: with that file readable, git really does run it
        expect(() =>
          execFileSync("git", ["commit", "--allow-empty", "-m", "signed"], {
            cwd: work,
            stdio: "pipe",
            env: { ...process.env, HOME: home },
          }),
        ).toThrow();
        expect(existsSync(marker)).toBe(true);
        rmSync(marker, { force: true });

        const sha = await commitAll(createRunner(), work, "BP-516: staged work", IDENTITY);

        expect(existsSync(marker), "the signing program ran anyway").toBe(false);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    });
  });

  // The control. Without it a mis-wired fixture — a payload that never had a chance to run, a
  // worktree with nothing staged — would read exactly like a refusal that worked.
  describe("a checkout the agent left alone", () => {
    it("commits, and returns the sha it created", async () => {
      const sha = await commitAll(createRunner(), work, "BP-403: ordinary work", IDENTITY);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(work, "rev-parse", "HEAD").trim()).toBe(sha);
      expect(git(work, "show", "--pretty=format:", "--name-only", "HEAD").trim()).toBe("a.txt");
      expect(existsSync(marker)).toBe(false);
    });

    it("commits with the attribute still in place, so a gitattributes repository is not refused", async () => {
      // `* filter=z` is set by the fixture and stays set here: an attribute naming a filter no
      // config defines is inert, and refusing it would break every ordinary repository.
      git(work, "config", "filter.z.required", "false");

      expect(await commitAll(createRunner(), work, "BP-403: ordinary work", IDENTITY)).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
