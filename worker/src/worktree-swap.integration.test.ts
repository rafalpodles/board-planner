import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerConfig } from "./config.js";
import { createRunner, Runner } from "./exec.js";
import { createExecutor } from "./executor.js";
import { confine } from "./sandbox.js";
import { RunState, runStep, StepContext } from "./steps.js";
import { ClaimedTask, SnapshotEntry } from "./types.js";
import { createWorkspace, Worktree } from "./workspace.js";
import { claimedTask } from "./__fixtures__/task.js";
import { workerConfig } from "./__fixtures__/config.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.com", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.com" },
  }).toString();
}

/**
 * BP-804. `subpath` covers the directory it names, so a confined process may remove its own
 * worktree and put a symlink where it was. Resolved again at the next spawn, that path is the
 * symlink's target, and the next step's `claude` would have been allowed to write there — `$HOME`,
 * played here by `home`. Real git, the real createWorkspace, the real executor and sandbox-exec; the
 * only stand-in is the CLI, a script that writes the file the real attack would.
 */
describe.skipIf(process.platform !== "darwin")("a worktree a confined process replaced with a symlink", () => {
  let dir: string;
  let home: string;
  let settings: string;
  let fakeClaude: string;
  let worktree: Worktree;
  let workspaceOver: (runner: Runner) => ReturnType<typeof createWorkspace>;
  const spawned: string[] = [];

  const recording: Runner = {
    run(command, args, opts) {
      spawned.push(args.at(-1) ?? command);
      return createRunner().run(command, args, opts);
    },
  };

  beforeEach(async () => {
    spawned.length = 0;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp804-swap-")));
    home = join(dir, "home");
    settings = join(home, "settings.json");
    mkdirSync(join(dir, "bin"));
    mkdirSync(home);
    writeFileSync(settings, "original\n");
    fakeClaude = join(dir, "bin", "claude");
    writeFileSync(fakeClaude, `#!/bin/sh\necho planted > '${settings}'\n`);
    chmodSync(fakeClaude, 0o755);

    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    writeFileSync(join(seed, "README.md"), "# t\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    const parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", origin, parent], { stdio: "pipe" });
    workspaceOver = (runner) =>
      createWorkspace(
        { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
        runner,
        gitPath,
        () => ({}),
        origin,
        { name: "worker", email: "worker@example.com" },
      );
    worktree = await workspaceOver(createRunner()).create("BP-1", "worker");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // What a daemon a Test gate left behind can do: the gate confined it to the worktree
  async function swapForSymlink(): Promise<void> {
    const spawn = confine("/bin/sh", ["-c", `rm -rf '${worktree.path}' && ln -s '${home}' '${worktree.path}'`], {
      writable: [worktree.path],
      env: {},
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const swapped = await createRunner().run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });
    expect(swapped.code, swapped.stderr).toBe(0);
    expect(realpathSync(worktree.path)).toBe(home);
  }

  function stepContext(task: ClaimedTask): StepContext {
    const state: RunState = {
      committed: false,
      uncommittedWork: false,
      commits: [],
      pushed: false,
      prUrl: "",
      merged: false,
      summary: "",
      checks: [],
      lastResult: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
    };
    return {
      worktreePath: worktree.path,
      worktreeDir: worktree.dir,
      branch: "bp-1/worker",
      task,
      executor: createExecutor(workerConfig(), recording, fakeClaude),
      delivery: {} as StepContext["delivery"],
      commit: async () => {
        throw new Error("nothing may be committed");
      },
      tampering: () => worktree.tampering(),
      state,
      timeoutMs: 30_000,
      baseSha: worktree.baseSha,
      runner: recording,
      gitPath,
    };
  }

  const implement: SnapshotEntry = { key: "implement", kind: "step", name: "Implement", capability: "edit", prompt: "go" };

  it("keeps the premise: resolved at the next spawn, the swapped path lets the step write its target", async () => {
    await swapForSymlink();

    const spawn = confine(fakeClaude, [], { writable: [realpathSync(worktree.path)], env: {} });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    await createRunner().run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });

    expect(readFileSync(settings, "utf8")).toBe("planted\n");
  });

  it("refuses the next step before spawning it, and its target is never written", async () => {
    await swapForSymlink();

    const outcome = await runStep(implement, stepContext(claimedTask({ taskKey: "BP-1" })));

    expect(outcome).toMatchObject({ kind: "tampered", finding: `its directory ${worktree.dir.path} replaced by a symlink` });
    expect(spawned).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe("original\n");
  });

  // The window between that check and the spawn: the confinement is to the path recorded at
  // creation, so it refuses rather than resolving the symlink
  it("refuses to confine to the recorded directory once it is a symlink", async () => {
    await swapForSymlink();

    const outcome = await createExecutor(workerConfig(), recording, fakeClaude).execute({
      task: claimedTask({ taskKey: "BP-1" }),
      worktreePath: worktree.path,
      worktreeDir: worktree.dir,
      brief: { prompt: "go", capability: "edit", model: "", fallbackModel: "", timeoutMs: 30_000 },
    });

    expect(outcome).toMatchObject({ kind: "machine_fault" });
    expect(outcome.kind === "machine_fault" && outcome.message).toContain("replaced by a symlink");
    expect(spawned).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe("original\n");
  });

  // The narrower window after the confinement is built: seatbelt matches the resolved path of each
  // write, so the literal recorded path permits nothing through a symlink put there afterwards
  it("permits nothing through a symlink put in its place after the profile was built", async () => {
    const spawn = confine("/bin/sh", ["-c", `echo planted > '${settings}'; echo planted > '${worktree.path}/settings.json'`], {
      writable: [worktree.dir],
      env: {},
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    await swapForSymlink();

    const result = await createRunner().run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });

    expect(result.stderr).toMatch(/Operation not permitted/);
    expect(readFileSync(settings, "utf8")).toBe("original\n");
  });

  it("names a directory re-created at the same path, which holds none of the checkout", async () => {
    const spawn = confine("/bin/sh", ["-c", `rm -rf '${worktree.path}' && mkdir '${worktree.path}'`], {
      writable: [worktree.dir],
      env: {},
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const result = await createRunner().run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);

    expect(await worktree.tampering()).toBe(`its directory ${worktree.dir.path} replaced by another directory`);
    expect(existsSync(join(worktree.path, ".git"))).toBe(false);
  });

  // The path is reused across attempts, so what an earlier attempt left running can swap the new
  // worktree before it is recorded
  it("refuses a worktree that is already a symlink when it is recorded", async () => {
    const racing: Runner = {
      async run(command, args, opts) {
        const result = await createRunner().run(command, args, opts);
        if (args.includes("worktree") && args.includes("add")) {
          rmSync(join(dir, "wt", "BP-2"), { recursive: true, force: true });
          symlinkSync(home, join(dir, "wt", "BP-2"));
        }
        return result;
      },
    };

    await expect(workspaceOver(racing).create("BP-2", "worker")).rejects.toThrow(`${join(dir, "wt", "BP-2")} is a symlink`);
  });
});
