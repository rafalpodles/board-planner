import { describe, it, expect, vi } from "vitest";
import { CommandResult, Runner } from "./exec.js";
import { GitPin, pinGit, pinTampering, PointerFiles, recordPin } from "./worktree-pin.js";

const gitPath = "/opt/homebrew/bin/git";
const POINTER = "gitdir: /repo/.git/worktrees/wt\n";
const PIN: GitPin = { workTree: "/wt", gitDir: "/repo/.git/worktrees/wt", pointer: POINTER, flagged: [] };

function shell(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
}

function listing(stdout: string, commonDir = "/repo/.git\n") {
  const run = vi.fn<Runner["run"]>(async (_command, args) =>
    shell(args.includes("ls-files") ? stdout : args.includes("--git-common-dir") ? commonDir : ""),
  );
  return { run };
}

function files(kind: ReturnType<PointerFiles["kind"]>, text = POINTER, workTree: ReturnType<PointerFiles["kind"]> = "directory"): PointerFiles {
  return { kind: (path) => (path === "/wt" ? workTree : kind), read: () => text, list: () => [], realpath: (path) => path, lstat: () => { throw new Error("unused"); } };
}

// A clone with an admin dir per entry, each `gitdir` naming the worktree git made it for
function clone(
  admins: Record<string, { gitdir: string; commondir?: string }>,
  pointer: string | null = POINTER,
): PointerFiles {
  return {
    list: (dir) => (dir === "/repo/.git/worktrees" ? Object.keys(admins) : []),
    realpath: (path) => path,
    lstat: () => { throw new Error("unused"); },
    kind: (path) => (path === "/wt/.git" && pointer !== null ? "file" : "missing"),
    read(path) {
      if (path === "/wt/.git" && pointer !== null) return pointer;
      const at = /^\/repo\/\.git\/worktrees\/([^/]+)\/(gitdir|commondir)$/.exec(path);
      const admin = at ? admins[at[1]] : undefined;
      if (!admin) throw new Error(`ENOENT ${path}`);
      return at![2] === "gitdir" ? admin.gitdir : (admin.commondir ?? "../..\n");
    },
  };
}

describe("pinGit", () => {
  function spawned(command: string, cwd: string) {
    const inner = { run: vi.fn<Runner["run"]>(async () => shell()) };
    return pinGit(inner, () => [PIN])
      .run(command, ["status"], { cwd, timeoutMs: 1, env: { HOME: "/h" } })
      .then(() => inner.run.mock.calls[0][2].env);
  }

  it("names the pinned git dir for git and gh in the worktree or below it", async () => {
    const pinned = { HOME: "/h", GIT_DIR: PIN.gitDir, GIT_WORK_TREE: "/wt" };
    expect(await spawned(gitPath, "/wt")).toEqual(pinned);
    expect(await spawned(gitPath, "/wt/src/deep")).toEqual(pinned);
    expect(await spawned("/opt/homebrew/bin/gh", "/wt")).toEqual(pinned);
  });

  it("keeps the environment a spawn with none would have had", async () => {
    const inner = { run: vi.fn<Runner["run"]>(async () => shell()) };
    await pinGit(inner, () => [PIN]).run(gitPath, ["status"], { cwd: "/wt", timeoutMs: 1 });

    expect(inner.run.mock.calls[0][2].env).toEqual(expect.objectContaining({ PATH: expect.any(String), GIT_DIR: PIN.gitDir }));
  });

  it("pins to whichever of several worktrees the cwd is in", async () => {
    const inner = { run: vi.fn<Runner["run"]>(async () => shell()) };
    const second = { workTree: "/other", gitDir: "/repo/.git/worktrees/other" };
    await pinGit(inner, () => [PIN, second]).run(gitPath, ["status"], { cwd: "/other/src", timeoutMs: 1, env: {} });

    expect(inner.run.mock.calls[0][2].env).toEqual({ GIT_DIR: second.gitDir, GIT_WORK_TREE: "/other" });
  });

  it("overrides a GIT_DIR or GIT_WORK_TREE the caller set", async () => {
    const inner = { run: vi.fn<Runner["run"]>(async () => shell()) };
    await pinGit(inner, () => [PIN]).run(gitPath, ["status"], {
      cwd: "/wt",
      timeoutMs: 1,
      env: { GIT_DIR: "/wt/node_modules/.y", GIT_WORK_TREE: "/elsewhere" },
    });

    expect(inner.run.mock.calls[0][2].env).toEqual({ GIT_DIR: PIN.gitDir, GIT_WORK_TREE: "/wt" });
  });

  it("leaves a sibling that shares the prefix, and anything that is not git or gh, alone", async () => {
    expect(await spawned(gitPath, "/wt2")).toEqual({ HOME: "/h" });
    expect(await spawned(gitPath, "/tmp/scratch")).toEqual({ HOME: "/h" });
    expect(await spawned("/usr/bin/sandbox-exec", "/wt")).toEqual({ HOME: "/h" });
  });
});

describe("recordPin", () => {
  it("derives the git dir from the clone, and records the pointer and the flags the checkout starts with", async () => {
    const runner = listing("H a.ts\0S sparse/b.ts\0");
    const found = clone({ other: { gitdir: "/elsewhere/.git\n" }, wt: { gitdir: "/wt/.git\n" } });

    expect(await recordPin(runner, gitPath, "/repo", "/wt", found)).toEqual({
      ...PIN,
      flagged: ["skip-worktree sparse/b.ts"],
    });
    expect(runner.run.mock.calls[0][2].cwd).toBe("/repo");
    expect(runner.run.mock.calls[1][2].env).toEqual(expect.objectContaining({ GIT_DIR: PIN.gitDir, GIT_WORK_TREE: "/wt" }));
  });

  it("accepts the relative spelling git writes under worktree.useRelativePaths", async () => {
    const relative = "gitdir: ../repo/.git/worktrees/wt\n";
    const found = clone({ wt: { gitdir: "../../../../wt/.git\n" } }, relative);

    expect(await recordPin(listing(""), gitPath, "/repo", "/wt", found)).toEqual({ ...PIN, pointer: relative });
  });

  // BP-794 review: the path is reused across attempts, so something an earlier attempt left running
  // can rewrite the new .git before this reads it
  it("refuses a pointer that is already not what git wrote", async () => {
    const found = clone({ wt: { gitdir: "/wt/.git\n" } }, "gitdir: /wt/node_modules/.y\n");

    await expect(recordPin(listing(""), gitPath, "/repo", "/wt", found)).rejects.toThrow(
      'refusing the new worktree: its .git file reads "gitdir: /wt/node_modules/.y" where git wrote "gitdir: /repo/.git/worktrees/wt"',
    );
  });

  // Another worktree's admin dir is still under the clone's worktrees/, and still not this one's
  it.each(["gitdir: ../repo/.git/worktrees/other\n", "gitdir: /repo/.git/worktrees/other\n"])(
    "refuses a pointer naming another worktree's admin dir: %j",
    async (pointer) => {
      const found = clone({ wt: { gitdir: "/wt/.git\n" }, other: { gitdir: "/other/.git\n" } }, pointer);

      await expect(recordPin(listing(""), gitPath, "/repo", "/wt", found)).rejects.toThrow("refusing the new worktree");
    },
  );

  it("resolves a relative common dir against the clone", async () => {
    const found = clone({ wt: { gitdir: "/wt/.git\n" } });

    expect((await recordPin(listing("", ".git\n"), gitPath, "/repo", "/wt", found)).gitDir).toBe(PIN.gitDir);
  });

  it("refuses a worktree with no .git file", async () => {
    const found = clone({ wt: { gitdir: "/wt/.git\n" } }, null);

    await expect(recordPin(listing(""), gitPath, "/repo", "/wt", found)).rejects.toThrow(/its \.git file is missing/);
  });

  it("refuses when no admin dir, or more than one, names the worktree", async () => {
    await expect(recordPin(listing(""), gitPath, "/repo", "/wt", clone({}))).rejects.toThrow(/records 0 git dirs/);
    await expect(
      recordPin(listing(""), gitPath, "/repo", "/wt", clone({ a: { gitdir: "/wt/.git\n" }, b: { gitdir: "/wt/.git\n" } })),
    ).rejects.toThrow(/records 2 git dirs/);
  });

  it("does not take an admin dir whose commondir names another repository", async () => {
    const found = clone({ wt: { gitdir: "/wt/.git\n", commondir: "/wt/node_modules/.y\n" } });

    await expect(recordPin(listing(""), gitPath, "/repo", "/wt", found)).rejects.toThrow(/records 0 git dirs/);
  });

  it("refuses a clone git will not name a common dir for", async () => {
    await expect(recordPin(listing("", ""), gitPath, "/repo", "/wt", clone({}))).rejects.toThrow(
      /could not tell where the clone's git dir is/,
    );
  });
});

describe("pinTampering", () => {
  it("finds nothing when the pointer and the flags are as recorded", async () => {
    expect(await pinTampering(listing("H a.ts\0"), gitPath, PIN, files("file"))).toBeNull();
  });

  it("names a rewritten pointer, quoting both", async () => {
    const found = await pinTampering(listing(""), gitPath, PIN, files("file", "gitdir: /wt/.y\n"));

    expect(found).toBe(
      'its .git file reading "gitdir: /wt/.y" where git wrote "gitdir: /repo/.git/worktrees/wt", which would point git at another repository',
    );
  });

  it("names a pointer that differs by a byte git would not show", async () => {
    expect(await pinTampering(listing(""), gitPath, PIN, files("file", `${POINTER}\n`))).toContain("its .git file reading");
  });

  it.each([
    ["missing", "its .git file removed"],
    ["directory", "a directory at .git where git wrote a file"],
    ["symlink", "a symlink at .git where git wrote a file"],
  ] as const)("names a pointer that is now %s", async (kind, said) => {
    expect(await pinTampering(listing(""), gitPath, PIN, files(kind))).toContain(said);
  });

  it("says the worktree is gone when the whole directory is", async () => {
    expect(await pinTampering(listing(""), gitPath, PIN, files("missing", POINTER, "missing"))).toBe("its whole directory removed, /wt included");
  });

  it("names a skip-worktree or assume-unchanged flag the checkout did not start with", async () => {
    const found = await pinTampering(listing("S a.ts\0h b.ts\0s c.ts\0H d.ts\0"), gitPath, PIN, files("file"));

    expect(found).toBe(
      "index flags that hide edits to tracked files from git status and git add: skip-worktree a.ts, assume-unchanged b.ts, skip-worktree c.ts",
    );
  });

  it("does not count a sparse checkout's own flags", async () => {
    const sparse = { ...PIN, flagged: ["skip-worktree sparse/b.ts"] };

    expect(await pinTampering(listing("S sparse/b.ts\0"), gitPath, sparse, files("file"))).toBeNull();
  });

  it("asks git with the pinned git dir, not through the pointer", async () => {
    const runner = listing("");
    await pinTampering(runner, gitPath, PIN, files("file"));

    expect(runner.run.mock.calls[0][2].env).toEqual(
      expect.objectContaining({ GIT_DIR: PIN.gitDir, GIT_WORK_TREE: "/wt", GIT_CONFIG_GLOBAL: "/dev/null" }),
    );
  });

  it("throws rather than vouching for an index git would not list", async () => {
    const runner = { run: vi.fn<Runner["run"]>(async () => shell("", { code: 128, stderr: "fatal: index file corrupt" })) };

    await expect(pinTampering(runner, gitPath, PIN, files("file"))).rejects.toThrow(/index file corrupt/);
  });
});
