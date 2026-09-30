import { describe, it, expect, vi } from "vitest";
import { CommandResult, Runner } from "./exec.js";
import { GitPin, pinGit, pinTampering, PointerFiles, recordPin } from "./worktree-pin.js";

const gitPath = "/opt/homebrew/bin/git";
const POINTER = "gitdir: /repo/.git/worktrees/wt\n";
const PIN: GitPin = { workTree: "/wt", gitDir: "/repo/.git/worktrees/wt", pointer: POINTER, flagged: [] };

function shell(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
}

function listing(stdout: string, gitDir = "/repo/.git/worktrees/wt\n") {
  const run = vi.fn<Runner["run"]>(async (_command, args) =>
    shell(args.includes("ls-files") ? stdout : args.includes("--absolute-git-dir") ? gitDir : ""),
  );
  return { run };
}

function files(kind: ReturnType<PointerFiles["kind"]>, text = POINTER): PointerFiles {
  return { kind: () => kind, read: () => text };
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

  it("leaves a sibling that shares the prefix, and anything that is not git or gh, alone", async () => {
    expect(await spawned(gitPath, "/wt2")).toEqual({ HOME: "/h" });
    expect(await spawned(gitPath, "/tmp/scratch")).toEqual({ HOME: "/h" });
    expect(await spawned("/usr/bin/sandbox-exec", "/wt")).toEqual({ HOME: "/h" });
  });
});

describe("recordPin", () => {
  it("records the git dir, the pointer's bytes and the flags the checkout starts with", async () => {
    const runner = listing("H a.ts\0S sparse/b.ts\0");

    expect(await recordPin(runner, gitPath, "/wt", files("file"))).toEqual({
      ...PIN,
      flagged: ["skip-worktree sparse/b.ts"],
    });
  });

  it("refuses a git dir that is not an absolute path", async () => {
    await expect(recordPin(listing("", ".git\n"), gitPath, "/wt", files("file"))).rejects.toThrow(
      /could not tell where the new worktree's git dir is/,
    );
  });

  it("refuses a worktree with no .git file", async () => {
    await expect(recordPin(listing(""), gitPath, "/wt", files("directory"))).rejects.toThrow(/no \.git file/);
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
