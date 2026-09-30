import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, TamperedCheckoutError } from "./commit.js";
import { createRunner } from "./exec.js";
import { hiddenFromGit } from "./hidden-files.js";
import { confine } from "./sandbox.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");
const IDENTITY = { name: "worker", email: "worker@example.com" };
const EVIL = "evil.test.ts";

/**
 * BP-640. A path an ignore rule names is invisible to `git status --porcelain` and `git add --all`,
 * so it reaches no commit, no diff and no gate, while the Test gate still runs it. Real git in a
 * real linked worktree, because what is being asserted is which file git reads each rule from.
 */
describe("files hidden from git by a rule the repository does not own", () => {
  let dir: string;
  let main: string;
  let worktree: string;
  let baseSha: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.com", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.com" },
    }).toString();
  }

  const check = () => hiddenFromGit(createRunner(), gitPath, worktree, baseSha);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp640-hidden-")));
    main = join(dir, "main");
    worktree = join(dir, "worktree");
    execFileSync("git", ["init", "--quiet", "-b", "main", main], { stdio: "pipe" });
    writeFileSync(join(main, ".gitignore"), "node_modules/\ndist/\n.env\n");
    writeFileSync(join(main, "package.json"), "{}\n");
    git(main, "add", "--all");
    git(main, "commit", "--quiet", "-m", "base");
    baseSha = git(main, "rev-parse", "HEAD").trim();
    git(main, "worktree", "add", "--quiet", "-b", "work", worktree, baseSha);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function hideInInfoExclude(): string {
    const exclude = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    appendFileSync(exclude, `${EVIL}\n`);
    writeFileSync(join(worktree, EVIL), "it('runs', () => {});\n");
    return exclude;
  }

  it("keeps the premise: git status and git add both read the hidden file as not there", () => {
    hideInInfoExclude();

    expect(git(worktree, "status", "--porcelain")).toBe("");
    git(worktree, "add", "--all");
    expect(git(worktree, "diff", "--cached", "--name-only")).toBe("");
  });

  it("names .git/info/exclude and its line for a file hidden there", async () => {
    const exclude = hideInInfoExclude();
    const line = git(main, "check-ignore", "-v", "--no-index", EVIL).split(":")[1];

    const found = await check();

    expect(found?.kind).toBe("hidden");
    expect(found?.detail).toContain(`${EVIL} (${exclude}:${line}: "${EVIL}")`);
  });

  it("lets through what the repository's own .gitignore ignores", async () => {
    mkdirSync(join(worktree, "node_modules", "pkg", "lib"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "pkg", "lib", "index.js"), "");
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "main.js"), "");
    writeFileSync(join(worktree, ".env"), "SECRET=1\n");
    // `--directory` lists this unignored directory as well as its one ignored entry
    mkdirSync(join(worktree, "config"));
    writeFileSync(join(worktree, "config", ".env"), "SECRET=1\n");

    expect(await check()).toBeNull();
  });

  it("refuses a new .gitignore that ignores itself", async () => {
    mkdirSync(join(worktree, "sub"));
    writeFileSync(join(worktree, "sub", ".gitignore"), "*\n");
    writeFileSync(join(worktree, "sub", EVIL), "it('runs', () => {});\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");

    const found = await check();

    expect(found?.detail).toContain(`sub/${EVIL} (sub/.gitignore:1: "*")`);
  });

  it("refuses a rule added to the repository's own .gitignore, even once committed", async () => {
    appendFileSync(join(worktree, ".gitignore"), `${EVIL}\n`);
    writeFileSync(join(worktree, EVIL), "it('runs', () => {});\n");
    git(worktree, "commit", "--quiet", "-am", "ignore it");

    const found = await check();

    expect(found?.detail).toContain(`${EVIL} (.gitignore:4: "${EVIL}")`);
  });

  // The route a confined agent has: it cannot write the shared common dir, but `.git` in a linked
  // worktree is a file inside the worktree, and a git dir made of text files alone is enough.
  describe.skipIf(process.platform !== "darwin")("through a .git pointer a confined agent redirects", () => {
    it("refuses the file its own info/exclude hides", async () => {
      const fake = join(worktree, ".y");
      const script = [
        `mkdir -p ${fake}/objects/info ${fake}/refs/heads ${fake}/info`,
        `echo ${join(main, ".git", "objects")} > ${fake}/objects/info/alternates`,
        `echo 'ref: refs/heads/work' > ${fake}/HEAD`,
        `echo ${baseSha} > ${fake}/refs/heads/work`,
        `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n' > ${fake}/config`,
        `printf '.y\\n${EVIL}\\n' > ${fake}/info/exclude`,
        `echo 'gitdir: ${fake}' > ${worktree}/.git`,
        `echo "it('runs', () => {});" > ${worktree}/${EVIL}`,
      ].join(" && ");
      const spawn = confine("/bin/sh", ["-c", script], { writable: [worktree], env: {} });
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      const planted = await createRunner().run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
      expect(planted.code).toBe(0);
      git(worktree, "add", "--all");
      expect(git(worktree, "status", "--porcelain")).toBe("");

      const found = await check();

      expect(found?.detail).toContain(`${EVIL} (${fake}/info/exclude:2: "${EVIL}")`);
    });
  });

  describe("commitAll", () => {
    it("refuses to stage, naming the rule, instead of committing around the hidden file", async () => {
      const exclude = hideInInfoExclude();
      writeFileSync(join(worktree, "package.json"), '{"name":"x"}\n');

      const staged = commitAll(createRunner(), gitPath, worktree, "BP-640: work", IDENTITY, baseSha);

      await expect(staged).rejects.toBeInstanceOf(TamperedCheckoutError);
      await expect(staged).rejects.toThrow(`${exclude}:`);
      expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(baseSha);
    });

    it("still commits when only the repository's own .gitignore ignores anything", async () => {
      mkdirSync(join(worktree, "dist"));
      writeFileSync(join(worktree, "dist", "main.js"), "");
      writeFileSync(join(worktree, "package.json"), '{"name":"x"}\n');

      const sha = await commitAll(createRunner(), gitPath, worktree, "BP-640: work", IDENTITY, baseSha);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});
