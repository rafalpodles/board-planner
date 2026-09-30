import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, TamperedCheckoutError } from "./commit.js";
import { createDelivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { protectedPathsGate } from "./gates/protected-paths.js";
import { hiddenFromGit } from "./hidden-files.js";
import { unfinishedWork } from "./pipeline.js";
import { confine } from "./sandbox.js";
import { GateContext } from "./types.js";
import { GitPin, pinGit, recordPin } from "./worktree-pin.js";
import { claimedTask } from "./__fixtures__/task.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");
const IDENTITY = { name: "worker", email: "worker@example.com" };
// Pinned the way runTask pins its runner (BP-794), so every call here names the worktree's git dir
const pins: GitPin[] = [];
const runner = pinGit(createRunner(), () => pins);
const confined = process.platform === "darwin";

/**
 * BP-803. A Test gate runs the agent's code confined to the worktree, and that is enough to leave a
 * git repository inside it whose own `.git/config` names a clean filter. Checking a submodule for
 * dirt makes git spawn itself inside it with GIT_DIR cleared, so the filter then runs from the
 * worker's own git calls — outside the sandbox, which the marker proves: it lives in a directory
 * the planting could not write to.
 *
 * Planted through the real seatbelt on a Mac, so the premise "confined code can do this" is
 * measured rather than assumed; plainly elsewhere, where there is no sandbox to ask.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(gitPath, args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).toString();
}

describe("a git repository nested inside the worktree (BP-803)", () => {
  let dir: string;
  let main: string;
  let worktree: string;
  let marker: string;
  let baseSha: string;

  const ranOutsideTheSandbox = () => existsSync(marker);
  const gitlinks = () => git(worktree, "ls-files", "--stage").split("\n").filter((line) => line.startsWith("160000"));
  // A new mtime each time: the child only reads the file through the filter when stat says it may
  // have changed, and the first read refreshes the nested index
  let touches = 0;
  const makeStatDirty = () => {
    touches += 1;
    execFileSync("/usr/bin/touch", ["-t", `2020010101${String(touches).padStart(2, "0")}`, join(worktree, "sub", "f.txt")]);
  };

  async function plant(at: string) {
    const script = [
      "set -e",
      `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`,
      `cd "${worktree}"`,
      `"${gitPath}" init -q "${at}"`,
      `echo x > "${at}/f.txt"`,
      `"${gitPath}" -C "${at}" add f.txt`,
      `"${gitPath}" -C "${at}" -c user.name=a -c user.email=a@b commit -qm s`,
      `printf '#!/bin/sh\\necho ran >> "%s"\\ncat\\n' "${marker}" > "${at}/.git/payload.sh"`,
      `chmod +x "${at}/.git/payload.sh"`,
      `"${gitPath}" -C "${at}" config filter.x.clean "${worktree}/${at}/.git/payload.sh"`,
      `echo '* filter=x' > "${at}/.gitattributes"`,
      // The filter run once from inside, where the marker is out of reach
      ...(confined ? [`touch -t 201901010000 "${at}/f.txt"`, `"${gitPath}" -C "${at}" status --porcelain > /dev/null`] : []),
    ].join("\n");
    const spawn = confined
      ? confine("/bin/sh", ["-c", script], { writable: [worktree], env: {} })
      : { command: "/bin/sh", args: ["-c", script] };
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const result = await runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`planting failed: ${result.stderr}`);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bp803-nested-"));
    main = join(dir, "main");
    worktree = join(dir, "worktree");
    marker = join(dir, "filter-ran-outside-the-sandbox");

    execFileSync(gitPath, ["init", "--quiet", "-b", "main", main], { stdio: "pipe" });
    git(main, "config", "user.email", IDENTITY.email);
    git(main, "config", "user.name", IDENTITY.name);
    writeFileSync(join(main, "a.txt"), "base\n");
    writeFileSync(join(main, ".gitignore"), "node_modules/\n");
    git(main, "add", "--all");
    git(main, "commit", "--quiet", "-m", "base");
    baseSha = git(main, "rev-parse", "HEAD").trim();
    git(main, "worktree", "add", "--quiet", "-b", "task/worker", worktree, baseSha);
    pins.splice(0, pins.length, await recordPin(createRunner(), gitPath, main, worktree));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("left untracked", () => {
    beforeEach(async () => {
      await plant("sub");
      writeFileSync(join(worktree, "a.txt"), "what the edit step wrote\n");
      makeStatDirty();
    });

    it.skipIf(!confined)("was planted from inside the sandbox, whose own run of the filter could not write the marker", () => {
      expect(existsSync(join(worktree, "sub", ".git", "config"))).toBe(true);
      expect(ranOutsideTheSandbox()).toBe(false);
    });

    it("is live: once plain git stages it, a plain status runs the filter outside the sandbox", () => {
      git(worktree, "add", "--all");
      makeStatDirty();
      git(worktree, "status", "--porcelain");
      expect(ranOutsideTheSandbox()).toBe(true);
    });

    it("makes commitAll refuse before anything is staged, and the filter never runs", async () => {
      const outcome = await commitAll(runner, gitPath, worktree, "BP-803: work", IDENTITY, baseSha).catch((error) => error);
      // The commit this would have made stages the gitlink, and the check after the step asks again
      await unfinishedWork(runner, gitPath, worktree, baseSha);
      writeFileSync(join(worktree, "a.txt"), "what the next edit step wrote\n");
      makeStatDirty();
      await commitAll(runner, gitPath, worktree, "BP-803: more work", IDENTITY, baseSha).catch(() => undefined);

      expect(ranOutsideTheSandbox()).toBe(false);
      expect(outcome).toBeInstanceOf(TamperedCheckoutError);
      expect(String(outcome)).toMatch(/sub\/ \(untracked\)/);
      expect(gitlinks()).toEqual([]);
    });

    it("is refused at the checkpoint before every gate", async () => {
      const found = await hiddenFromGit(runner, gitPath, worktree, baseSha);

      expect(found?.kind).toBe("nested");
      expect(found?.detail).toMatch(/nested inside the worktree.*sub\/ \(untracked\)/);
    });

    it("is refused when found one level further down", async () => {
      rmSync(join(worktree, "sub"), { recursive: true, force: true });
      mkdirSync(join(worktree, "pkg"));
      writeFileSync(join(worktree, "pkg", "index.ts"), "export {};\n");
      await plant("pkg/deep");

      const found = await hiddenFromGit(runner, gitPath, worktree, baseSha);

      expect(found?.detail).toMatch(/pkg\/deep\/ \(untracked\)/);
    });
  });

  describe("already staged as a gitlink", () => {
    beforeEach(async () => {
      await plant("sub");
      // What the unguarded commit before this fix did with it; staging a new gitlink reads the
      // nested repository's HEAD and nothing else
      git(worktree, "add", "--all");
      expect(gitlinks()).toHaveLength(1);
      writeFileSync(join(worktree, "a.txt"), "what the edit step wrote\n");
      makeStatDirty();
    });

    it("makes commitAll refuse, and neither its status nor its add runs the filter", async () => {
      const outcome = await commitAll(runner, gitPath, worktree, "BP-803: work", IDENTITY, baseSha).catch((error) => error);

      expect(ranOutsideTheSandbox()).toBe(false);
      expect(outcome).toBeInstanceOf(TamperedCheckoutError);
      expect(String(outcome)).toMatch(/sub \(a submodule path with a \.git in it\)/);
    });

    // The check after an edit step asks `status` first. `.gitmodules` is the agent's file, and its
    // `ignore = none` outranks `diff.ignoreSubmodules` in config — but not the flag.
    it("is reported unclean after an edit step without the status there running the filter", async () => {
      writeFileSync(join(worktree, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\tignore = none\n');

      const leftover = await unfinishedWork(runner, gitPath, worktree, baseSha);

      expect(leftover).toBeTruthy();
      expect(ranOutsideTheSandbox()).toBe(false);
    });

    it("keeps gh from running at all, since `gh pr create` runs a status of its own", async () => {
      const ghRan = join(dir, "gh-ran");
      const gh = join(dir, "gh");
      writeFileSync(gh, `#!/bin/sh\ntouch "${ghRan}"\necho https://github.com/x/y/pull/1\n`);
      chmodSync(gh, 0o755);
      const delivery = createDelivery(runner, gitPath, gh);

      await expect(delivery.openPr(worktree, claimedTask(), "summary")).rejects.toThrow(
        /refusing to open a pull request: .*sub \(a submodule path/,
      );
      await expect(delivery.push(worktree, "task/worker", baseSha)).rejects.toThrow(/refusing to push: .*nested/);
      expect(existsSync(ghRan)).toBe(false);
      expect(ranOutsideTheSandbox()).toBe(false);
    });
  });

  describe("what is not a nested repository to refuse", () => {
    it("lets a repository under an ignored directory be, as git dependencies in node_modules are", async () => {
      mkdirSync(join(worktree, "node_modules"));
      await plant("node_modules/dep");
      writeFileSync(join(worktree, "a.txt"), "what the edit step wrote\n");
      execFileSync("/usr/bin/touch", ["-t", "202001010101", join(worktree, "node_modules", "dep", "f.txt")]);

      const sha = await commitAll(runner, gitPath, worktree, "BP-803: work", IDENTITY, baseSha);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(worktree, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
      expect(ranOutsideTheSandbox()).toBe(false);
    });

    it("lets the base's own submodule through while nobody has populated it", async () => {
      const upstream = join(dir, "upstream");
      execFileSync(gitPath, ["init", "--quiet", "-b", "main", upstream], { stdio: "pipe" });
      writeFileSync(join(upstream, "lib.txt"), "lib\n");
      git(upstream, "add", "lib.txt");
      git(upstream, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "--quiet", "-m", "lib");
      git(main, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", upstream, "vendor/lib");
      git(main, "commit", "--quiet", "-m", "vendor a submodule");
      const withSubmodule = git(main, "rev-parse", "HEAD").trim();
      const second = join(dir, "second");
      git(main, "worktree", "add", "--quiet", "-b", "task2/worker", second, withSubmodule);
      pins.push(await recordPin(createRunner(), gitPath, main, second));
      writeFileSync(join(second, "a.txt"), "what the edit step wrote\n");

      const sha = await commitAll(runner, gitPath, second, "BP-803: work", IDENTITY, withSubmodule);

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    // A change that is only a submodule pointer has to be committed, so protected-paths is what
    // hands it to a person. `--ignore-submodules=all` read each of these as a clean tree: nothing
    // was committed, the check after the step found nothing, and the change was dropped.
    describe("a change that is only a submodule pointer, with the submodule left empty", () => {
      let second: string;
      let withSubmodule: string;
      let bumped: string;

      beforeEach(async () => {
        const upstream = join(dir, "upstream");
        execFileSync(gitPath, ["init", "--quiet", "-b", "main", upstream], { stdio: "pipe" });
        for (const content of ["one\n", "two\n"]) {
          writeFileSync(join(upstream, "lib.txt"), content);
          git(upstream, "add", "lib.txt");
          git(upstream, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "--quiet", "-m", content.trim());
        }
        bumped = git(upstream, "rev-parse", "HEAD").trim();
        git(main, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", upstream, "vendor/lib");
        git(join(main, "vendor", "lib"), "checkout", "--quiet", "HEAD~1");
        git(main, "add", "vendor/lib");
        git(main, "commit", "--quiet", "-m", "vendor a submodule");
        withSubmodule = git(main, "rev-parse", "HEAD").trim();
        second = join(dir, "second");
        git(main, "worktree", "add", "--quiet", "-b", "task2/worker", second, withSubmodule);
        pins.push(await recordPin(createRunner(), gitPath, main, second));
      });

      const refusedByProtectedPaths = async () => {
        const diff = await collectDiff(runner, gitPath, second, withSubmodule);
        expect(diff.gitlinks).toEqual(["vendor/lib"]);
        const verdict = await protectedPathsGate().run({ diff } as GateContext);
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toMatch(/submodule pointer/);
      };

      it("commits a staged bump, and protected-paths refuses it", async () => {
        git(second, "update-index", "--cacheinfo", `160000,${bumped},vendor/lib`);

        const sha = await commitAll(runner, gitPath, second, "BP-803: work", IDENTITY, withSubmodule);

        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        await refusedByProtectedPaths();
      });

      it("commits a new gitlink, and protected-paths refuses it", async () => {
        mkdirSync(join(second, "vendor", "other"));
        git(second, "update-index", "--add", "--cacheinfo", `160000,${bumped},vendor/other`);

        const sha = await commitAll(runner, gitPath, second, "BP-803: work", IDENTITY, withSubmodule);

        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        const diff = await collectDiff(runner, gitPath, second, withSubmodule);
        expect(diff.gitlinks).toEqual(["vendor/other"]);
        expect((await protectedPathsGate().run({ diff } as GateContext)).ok).toBe(false);
      });

      // Nothing is brought in, so protected-paths has nothing to refuse; what matters is that it
      // is committed rather than dropped
      it.each([
        ["a staged removal", (at: string) => git(at, "rm", "--quiet", "--cached", "vendor/lib")],
        ["the empty directory removed", (at: string) => rmSync(join(at, "vendor", "lib"), { recursive: true })],
      ])("commits %s", async (_what, change) => {
        change(second);

        const sha = await commitAll(runner, gitPath, second, "BP-803: work", IDENTITY, withSubmodule);

        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect((await collectDiff(runner, gitPath, second, withSubmodule)).changedFiles).toContain("vendor/lib");
      });

      it("is reported unclean by the check after a step when it was not committed", async () => {
        git(second, "update-index", "--cacheinfo", `160000,${bumped},vendor/lib`);

        expect(await unfinishedWork(runner, gitPath, second, withSubmodule)).toMatch(/vendor\/lib/);
      });
    });
  });
});
