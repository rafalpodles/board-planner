import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenByTheRunsOwnRules } from "./ignored-work.js";
import { createRunner, Runner } from "./exec.js";

/**
 * BP-508. Real git, because every claim here is about what `git status` hides and what
 * `check-ignore` will admit to — a stubbed runner would answer whatever it was told, which is the
 * shape that let this survive.
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

describe("work hidden by an ignore rule the run itself added", () => {
  let dir: string;
  let work: string;
  let baseSha: string;

  const ask = () => hiddenByTheRunsOwnRules(createRunner(), work, baseSha);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp508-"));
    work = join(dir, "work");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    git(work, "config", "user.email", "w@e");
    git(work, "config", "user.name", "w");

    // The repository's own ignore rule, and the build output it exists for: both predate the run
    writeFileSync(join(work, ".gitignore"), "node_modules/\n");
    writeFileSync(join(work, "a.ts"), "export const a = 1;\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "base");
    baseSha = git(work, "rev-parse", "HEAD").trim();

    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "node_modules", "x.js"), "installed\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * The premise, asserted on its own: the tree check this protects reads `status --porcelain`, and
   * that is blind to both directories below. If this stops being true the cases below stop being
   * about anything.
   */
  it("is invisible to the check it protects", () => {
    writeFileSync(join(work, ".gitignore"), "node_modules/\nsecret/\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "the run adds a rule");
    mkdirSync(join(work, "secret"));
    writeFileSync(join(work, "secret", "work.ts"), "a day of work\n");

    expect(git(work, "status", "--porcelain").trim()).toBe("");
  });

  /**
   * The control, and the one that decides whether this is a guard or a blunt instrument: a run that
   * touches its .gitignore for an unrelated reason must not be failed by the build output the
   * repository has always ignored. `--ignored` on its own reports node_modules here and fails it.
   */
  it("says nothing about work a rule that predates the run is hiding", async () => {
    writeFileSync(join(work, ".gitignore"), "node_modules/\n# a comment the run added\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "the run edits the file but not the rule");

    expect(await ask()).toEqual([]);
  });

  /**
   * The cost, asserted rather than described. Removing the "did the run touch an ignore file"
   * gate changes no verdict — a rule that predates the run is not the run's whichever way you
   * reach it — so the only thing that mutation moves is how much git the ordinary run pays for.
   * One diff, and nothing else.
   */
  it("asks git one question when the run did not touch an ignore file", async () => {
    writeFileSync(join(work, "a.ts"), "export const a = 2;\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "ordinary work");

    const real = createRunner();
    const calls: string[][] = [];
    const counting: Runner = {
      run: (command, args, opts) => {
        calls.push(args);
        return real.run(command, args, opts);
      },
    };

    expect(await hiddenByTheRunsOwnRules(counting, work, baseSha)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--name-only");
  });

  it("names the work, the rule hiding it, and the file the rule came from", async () => {
    writeFileSync(join(work, ".gitignore"), "node_modules/\nsecret/\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "the run adds a rule");
    mkdirSync(join(work, "secret"));
    writeFileSync(join(work, "secret", "work.ts"), "a day of work\n");

    const hidden = await ask();

    expect(hidden).toEqual([{ path: "secret/", rule: "secret/ in .gitignore" }]);
    // and the repository's own rule is not among them, in the same answer
    expect(JSON.stringify(hidden)).not.toContain("node_modules");
  });

  it("treats a rule in .git/info/exclude as the run's, since no commit can hold it", async () => {
    writeFileSync(join(work, ".gitignore"), "node_modules/\n# touched\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "the run touches the ignore file");
    writeFileSync(join(work, ".git", "info", "exclude"), "secret/\n");
    mkdirSync(join(work, "secret"));
    writeFileSync(join(work, "secret", "work.ts"), "a day of work\n");

    expect(await ask()).toEqual([
      { path: "secret/", rule: "secret/ in .git/info/exclude" },
    ]);
  });

  it("treats a .gitignore the run created outright as the run's", async () => {
    rmSync(join(work, ".gitignore"));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "remove it");
    writeFileSync(join(work, "nested.gitignore"), "");
    mkdirSync(join(work, "sub"));
    writeFileSync(join(work, "sub", ".gitignore"), "hidden/\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "a new ignore file in a subdirectory");
    mkdirSync(join(work, "sub", "hidden"));
    writeFileSync(join(work, "sub", "hidden", "work.ts"), "a day of work\n");

    const hidden = await ask();

    expect(hidden).toEqual([{ path: "sub/hidden/", rule: "hidden/ in sub/.gitignore" }]);
  });
});
