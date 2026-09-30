import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, TamperedCheckoutError } from "./commit.js";
import { createRunner, Runner } from "./exec.js";
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
    mkdirSync(join(main, "logs"));
    writeFileSync(join(main, "logs", ".gitignore"), "*.log\n!keep.log\n");
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

  // check-ignore reads stdin as pathspecs, where `:evil/` means `evil/` from the top — which no rule
  // ignores, so nothing was printed for it and the path went through as a directory
  it("refuses a path spelled like pathspec magic, hidden by a committed rule", async () => {
    appendFileSync(join(worktree, ".gitignore"), ":*/\n");
    git(worktree, "commit", "--quiet", "-am", "ignore it");
    mkdirSync(join(worktree, ":evil"));
    writeFileSync(join(worktree, ":evil", "e.test.js"), "it('runs', () => {});\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");

    const found = await check();

    expect(found?.detail).toContain(`:evil/ (.gitignore:4: ":*/")`);
  });

  it("refuses the same through .git/info/exclude", async () => {
    const exclude = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    appendFileSync(exclude, ":*/\n");
    mkdirSync(join(worktree, ":evil"));
    writeFileSync(join(worktree, ":evil", "e.test.js"), "it('runs', () => {});\n");

    const found = await check();

    expect(found?.detail).toContain(`:evil/ (${exclude}:`);
  });

  it("refuses a file a base line hides only because the agent deleted the negation after it", async () => {
    writeFileSync(join(worktree, "logs", ".gitignore"), "*.log\n");
    writeFileSync(join(worktree, "logs", "keep.log"), "hidden\n");
    git(worktree, "commit", "--quiet", "-am", "drop the negation");

    const found = await check();

    expect(found?.detail).toContain(`logs/keep.log (logs/.gitignore:1: "*.log")`);
  });

  it("still trusts the base's rules in a .gitignore the task legitimately edited", async () => {
    appendFileSync(join(worktree, ".gitignore"), "coverage/\n");
    git(worktree, "commit", "--quiet", "-am", "ignore coverage");
    mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(worktree, "logs", "a.log"), "");

    expect(await check()).toBeNull();
  });

  it("asks about npm ci's tree as one directory, not as its files", async () => {
    mkdirSync(join(worktree, "node_modules", "pkg", "lib"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "pkg", "lib", "index.js"), "");
    const real = createRunner();
    const stdins: string[] = [];
    const recording: Runner = {
      run: (command, args, opts) => {
        if (args.includes("check-ignore")) stdins.push(opts.stdin ?? "");
        return real.run(command, args, opts);
      },
    };

    expect(await hiddenFromGit(recording, gitPath, worktree, baseSha)).toBeNull();
    expect(stdins.join("")).toContain("./node_modules/\0");
    expect(stdins.join("")).not.toContain("node_modules/pkg");
  });

  it("trusts the base's rules in a checkout whose .gitignore has CRLF line endings", async () => {
    const crlfMain = join(dir, "crlf-main");
    const crlfWorktree = join(dir, "crlf-worktree");
    execFileSync("git", ["init", "--quiet", "-b", "main", crlfMain], { stdio: "pipe" });
    writeFileSync(join(crlfMain, ".gitattributes"), "* text eol=crlf\n");
    writeFileSync(join(crlfMain, ".gitignore"), "node_modules/\n");
    git(crlfMain, "add", "--all");
    git(crlfMain, "commit", "--quiet", "-m", "base");
    const crlfBase = git(crlfMain, "rev-parse", "HEAD").trim();
    git(crlfMain, "worktree", "add", "--quiet", "-b", "work", crlfWorktree, crlfBase);
    expect(readFileSync(join(crlfWorktree, ".gitignore"), "utf8")).toBe("node_modules/\r\n");
    mkdirSync(join(crlfWorktree, "node_modules"));
    writeFileSync(join(crlfWorktree, "node_modules", "x.js"), "");

    expect(await hiddenFromGit(createRunner(), gitPath, crlfWorktree, crlfBase)).toBeNull();
  });

  function separateRepository(name: string, files: Record<string, string>, ignoreCase: boolean) {
    const repo = join(dir, `${name}-main`);
    const work = join(dir, `${name}-worktree`);
    execFileSync("git", ["init", "--quiet", "-b", "main", repo], { stdio: "pipe" });
    for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "base");
    git(repo, "config", "core.ignorecase", String(ignoreCase));
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "worktree", "add", "--quiet", "-b", "work", work, base);
    return { repo, work, base };
  }

  // The scratch repository is made on the TMP volume, case-insensitive on a Mac, and took its
  // core.ignoreCase from there rather than from the worktree's
  it("judges the base's rules with the worktree's case sensitivity, not the TMP volume's", async () => {
    const { work, base } = separateRepository("case", { ".gitignore": "Dist/\n" }, false);
    const exclude = git(work, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    mkdirSync(join(work, "dist"));
    writeFileSync(join(work, "dist", "e.test.js"), "it('runs', () => {});\n");
    expect(git(work, "status", "--porcelain")).toBe("?? dist/\n");
    appendFileSync(exclude, "dist/\n");
    expect(git(work, "status", "--porcelain")).toBe("");

    const found = await hiddenFromGit(createRunner(), gitPath, work, base);

    expect(found?.detail).toContain(`dist/ (${exclude}:`);
  });

  it("still trusts a base rule that matches only case-insensitively where the checkout is", async () => {
    const { work, base } = separateRepository("nocase", { ".gitignore": "Dist/\n" }, true);
    mkdirSync(join(work, "dist"));
    writeFileSync(join(work, "dist", "e.test.js"), "");
    expect(git(work, "status", "--porcelain")).toBe("");

    expect(await hiddenFromGit(createRunner(), gitPath, work, base)).toBeNull();
  });

  it("does not read a symlinked base .gitignore as rules, as git does not", async () => {
    const repo = join(dir, "symlink-main");
    const work = join(dir, "symlink-worktree");
    execFileSync("git", ["init", "--quiet", "-b", "main", repo], { stdio: "pipe" });
    symlinkSync("*", join(repo, ".gitignore"));
    writeFileSync(join(repo, "package.json"), "{}\n");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "worktree", "add", "--quiet", "-b", "work", work, base);
    const exclude = git(work, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    appendFileSync(exclude, `${EVIL}\n`);
    writeFileSync(join(work, EVIL), "it('runs', () => {});\n");

    const found = await hiddenFromGit(createRunner(), gitPath, work, base);

    expect(found?.detail).toContain(`${EVIL} (${exclude}:`);
  });

  it("leaves no scratch repository behind", async () => {
    const scratchRoot = join(dir, "tmp");
    mkdirSync(scratchRoot);
    const realTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = scratchRoot;
    try {
      hideInInfoExclude();
      expect((await check())?.kind).toBe("hidden");
    } finally {
      if (realTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = realTmpdir;
    }

    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("reads a base .gitignore that is not UTF-8 beside another one", async () => {
    const { work, base } = separateRepository("latin1", { "package.json": "{}\n" }, false);
    const repo = join(dir, "latin1-main");
    writeFileSync(join(repo, ".gitignore"), Buffer.from("# caf\xe9\nnode_modules/\n", "latin1"));
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", ".gitignore"), "*.log\n");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "ignores");
    const withIgnores = git(repo, "rev-parse", "HEAD").trim();
    git(work, "checkout", "--quiet", "--detach", withIgnores);
    mkdirSync(join(work, "node_modules"));
    writeFileSync(join(work, "node_modules", "x.js"), "");
    writeFileSync(join(work, "sub", "a.log"), "");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(base).not.toBe(withIgnores);

    expect(await hiddenFromGit(createRunner(), gitPath, work, withIgnores)).toBeNull();
  });

  // BP-794 leaves a redirected .git config unscanned before a gate, so no call in here may read a
  // file through a clean filter such a config defines
  it("runs no clean filter the checkout defines", async () => {
    const fake = join(worktree, ".y");
    const marker = join(dir, "filter-ran");
    const payload = join(dir, "payload.sh");
    writeFileSync(payload, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    mkdirSync(join(fake, "objects", "info"), { recursive: true });
    mkdirSync(join(fake, "refs", "heads"), { recursive: true });
    mkdirSync(join(fake, "info"));
    writeFileSync(join(fake, "objects", "info", "alternates"), `${join(main, ".git", "objects")}\n`);
    writeFileSync(join(fake, "HEAD"), "ref: refs/heads/work\n");
    writeFileSync(join(fake, "refs", "heads", "work"), `${baseSha}\n`);
    writeFileSync(join(fake, "config"), `[core]\n\trepositoryformatversion = 0\n[filter "x"]\n\tclean = ${payload}\n`);
    writeFileSync(join(fake, "info", "attributes"), "* filter=x\n");
    writeFileSync(join(fake, "info", "exclude"), `.y\n${EVIL}\n`);
    writeFileSync(join(worktree, ".git"), `gitdir: ${fake}\n`);
    appendFileSync(join(worktree, ".gitignore"), "coverage/\n");
    writeFileSync(join(worktree, EVIL), "it('runs', () => {});\n");

    const found = await check();

    expect(found?.kind).toBe("hidden");
    expect(existsSync(marker)).toBe(false);
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
