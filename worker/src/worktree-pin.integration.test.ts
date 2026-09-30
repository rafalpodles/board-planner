import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "./api.js";
import { commitAll } from "./commit.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner, Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { gitArgs, localGitEnv } from "./git-safety.js";
import { hiddenFromGit } from "./hidden-files.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { Reporter } from "./reporter.js";
import { confine } from "./sandbox.js";
import { ClaimedTask, SnapshotEntry } from "./types.js";
import { createWorkspace, Worktree } from "./workspace.js";
import { pinGit } from "./worktree-pin.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");
const EVIL = "evil.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.com", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.com" },
  }).toString();
}

/**
 * BP-794. A confined step cannot write the main clone's `.git`, but a linked worktree's `.git` is a
 * file inside the worktree: rewritten to name a git dir of text files beside it, that becomes the
 * repository every later git call in the worktree uses — its remote, its ignore rules, its index.
 * Real git, a real linked worktree from the real createWorkspace, and a real sandbox-exec write.
 */
describe.skipIf(process.platform !== "darwin")("a worktree whose .git file a confined step rewrote", () => {
  let dir: string;
  let origin: string;
  let attacker: string;
  let parent: string;
  let worktree: Worktree;

  function workspace() {
    return createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      gitPath,
      () => ({}),
      origin,
      { name: "worker", email: "worker@example.com" },
    );
  }

  // Only what a confined agent has: a shell whose writes seatbelt holds to the worktree
  // Under node_modules/, which the repository's own .gitignore ignores, so BP-640's check lets the
  // planted git dir through; `hide` also hides a file of the agent's through its info/exclude
  async function redirectPointer(path: string, baseSha: string, hide = true): Promise<string> {
    const fake = join(path, "node_modules", ".y");
    const script = [
      `mkdir -p ${fake}/objects/info ${fake}/refs/heads/bp-1 ${fake}/info`,
      `echo ${join(parent, ".git", "objects")} > ${fake}/objects/info/alternates`,
      `echo 'ref: refs/heads/bp-1/worker' > ${fake}/HEAD`,
      `echo ${baseSha} > ${fake}/refs/heads/bp-1/worker`,
      `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n[remote "origin"]\\n\\turl = ${attacker}\\n' > ${fake}/config`,
      hide ? `printf '${EVIL}\\n' > ${fake}/info/exclude` : "true",
      `echo 'gitdir: ${fake}' > ${path}/.git`,
      hide ? `echo "it('runs', () => {});" > ${path}/${EVIL}` : "true",
      `echo '{"name":"t","scripts":{"postinstall":"sh x"}}' > ${path}/package.json`,
    ].join(" && ");
    const spawn = confine("/bin/sh", ["-c", script], { writable: [path], env: {} });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const planted = await createRunner().run(spawn.command, spawn.args, { cwd: path, timeoutMs: 30_000 });
    expect(planted.code, planted.stderr).toBe(0);
    return fake;
  }

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp794-pin-")));
    origin = join(dir, "origin.git");
    attacker = join(dir, "attacker.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", attacker], { stdio: "pipe" });
    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    writeFileSync(join(seed, "package.json"), '{"name":"t"}\n');
    writeFileSync(join(seed, "README.md"), "# t\n");
    writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", origin, parent], { stdio: "pipe" });
    worktree = await workspace().create("BP-1", "worker");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the premise: unpinned, git in the worktree reads the planted repository", async () => {
    const fake = await redirectPointer(worktree.path, worktree.baseSha);

    expect(git(worktree.path, "rev-parse", "--absolute-git-dir").trim()).toBe(fake);
    expect(git(worktree.path, "config", "--get", "remote.origin.url").trim()).toBe(attacker);
    expect(await hiddenFromGit(createRunner(), gitPath, worktree.path, worktree.baseSha)).not.toBeNull();
  });

  it("names the rewritten .git file", async () => {
    const fake = await redirectPointer(worktree.path, worktree.baseSha);

    const found = await worktree.tampering();

    expect(found).toContain(`its .git file reading ${JSON.stringify(`gitdir: ${fake}`)}`);
    expect(found).toContain(`where git wrote ${JSON.stringify(`gitdir: ${worktree.pin.gitDir}`)}`);
  });

  it("finds nothing on a worktree nobody touched", async () => {
    writeFileSync(join(worktree.path, "README.md"), "# t\nnotes\n");

    expect(await worktree.tampering()).toBeNull();
  });

  it("points every pinned git call at the git dir recorded at creation, whatever .git now says", async () => {
    await redirectPointer(worktree.path, worktree.baseSha);
    const runner: Runner = pinGit(createRunner(), () => [worktree.pin]);
    const ask = async (...args: string[]) =>
      (await runner.run(gitPath, gitArgs(args), { cwd: worktree.path, timeoutMs: 30_000, env: localGitEnv() })).stdout.trim();

    expect(await ask("rev-parse", "--absolute-git-dir")).toBe(worktree.pin.gitDir);
    expect(await ask("config", "--get", "remote.origin.url")).toBe(origin);
    // The planted info/exclude no longer hides anything: the file is one git sees
    expect(await hiddenFromGit(runner, gitPath, worktree.path, worktree.baseSha)).toBeNull();

    const sha = await commitAll(runner, gitPath, worktree.path, "BP-1: work", worktree.commitIdentity, worktree.baseSha);

    expect(git(parent, "rev-parse", "refs/heads/bp-1/worker").trim()).toBe(sha);
    expect(readFileSync(join(worktree.path, "node_modules", ".y", "refs", "heads", "bp-1", "worker"), "utf8").trim()).toBe(
      worktree.baseSha,
    );
    const diff = await collectDiff(runner, gitPath, worktree.path, worktree.baseSha);
    expect(diff.changedFiles.sort()).toEqual([EVIL, "package.json"]);
  });

  it("names a skip-worktree or assume-unchanged flag set after creation", async () => {
    const pinned = { ...process.env, GIT_DIR: worktree.pin.gitDir, GIT_WORK_TREE: worktree.path };
    execFileSync("git", ["update-index", "--skip-worktree", "package.json"], { cwd: worktree.path, env: pinned });
    execFileSync("git", ["update-index", "--assume-unchanged", "README.md"], { cwd: worktree.path, env: pinned });
    writeFileSync(join(worktree.path, "package.json"), '{"name":"t","scripts":{"postinstall":"sh x"}}\n');
    expect(git(worktree.path, "status", "--porcelain")).toBe("");

    const found = await worktree.tampering();

    expect(found).toContain("skip-worktree package.json");
    expect(found).toContain("assume-unchanged README.md");
  });

  // BP-794 review: the worktree path is reused across attempts, so a process an earlier attempt left
  // behind can rewrite the new .git between `worktree add` and the pin being recorded
  it("refuses a worktree whose .git file was rewritten before the pin was recorded", async () => {
    const fake = join(dir, "wt", "BP-2", "node_modules", ".y");
    const inner = createRunner();
    const racing: Runner = {
      async run(command, args, opts) {
        const result = await inner.run(command, args, opts);
        if (args.includes("worktree") && args.includes("add")) {
          writeFileSync(join(dir, "wt", "BP-2", ".git"), `gitdir: ${fake}\n`);
        }
        return result;
      },
    };
    const racedWorkspace = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      racing,
      gitPath,
      () => ({}),
      origin,
      { name: "worker", email: "worker@example.com" },
    );

    await expect(racedWorkspace.create("BP-2", "worker")).rejects.toThrow(
      `refusing the new worktree: its .git file reads ${JSON.stringify(`gitdir: ${fake}`)}`,
    );
  });

  it("records the clone's own admin dir, not whatever .git names", () => {
    expect(worktree.pin.gitDir).toBe(join(realpathSync(parent), ".git", "worktrees", "BP-1"));
    expect(worktree.pin.pointer).toBe(`gitdir: ${worktree.pin.gitDir}\n`);
  });

  // BP-794 review: with core.ignoreStat=true git marks every entry it checks out or stages
  // assume-unchanged, which read as tampering on every run that created a file
  it("does not take the flags core.ignoreStat would make git set for the worker's own staging", async () => {
    git(parent, "config", "core.ignoreStat", "true");
    const fresh = await workspace().create("BP-3", "worker");
    const runner = pinGit(createRunner(), () => [fresh.pin]);
    writeFileSync(join(fresh.path, "new.ts"), "export {};\n");

    const sha = await commitAll(runner, gitPath, fresh.path, "BP-3: work", fresh.commitIdentity, fresh.baseSha);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(fresh.pin.flagged).toEqual([]);
    expect(await fresh.tampering()).toBeNull();
  });

  describe("through a whole run", () => {
    const IMPLEMENT: SnapshotEntry = { key: "implement", kind: "step", name: "Implement", prompt: "p", capability: "edit" };
    const SIZE: SnapshotEntry = { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" };
    const PUSH: SnapshotEntry = { key: "push", kind: "step", name: "Push", deterministic: true };
    const task: ClaimedTask = {
      taskId: "t1",
      projectId: "BP",
      taskKey: "BP-1",
      taskNumber: 1,
      title: "t",
      description: "",
      acceptanceCriteria: [],
      attempts: 1,
      previousRejectionReason: "",
      runId: "run-1",
      agent: { agentId: "a1", name: "a", sequence: [IMPLEMENT, SIZE, PUSH] },
    };

    function run(step: (path: string) => Promise<void>) {
      const reporter = {
        blocked: vi.fn<Reporter["blocked"]>(async () => {}),
        gateRejected: vi.fn<Reporter["gateRejected"]>(async () => {}),
        released: vi.fn<Reporter["released"]>(async () => {}),
        requeued: vi.fn<Reporter["requeued"]>(async () => {}),
        merged: vi.fn<Reporter["merged"]>(async () => {}),
        delivered: vi.fn<Reporter["delivered"]>(async () => {}),
        failed: vi.fn<Reporter["failed"]>(async () => {}),
      };
      const delivery = {
        push: vi.fn<Delivery["push"]>(async () => {}),
        openPr: vi.fn<Delivery["openPr"]>(async () => "https://x/pull/1"),
        merge: vi.fn<Delivery["merge"]>(async () => {}),
      };
      const gate = { name: "Size", run: vi.fn(async () => ({ ok: true, reason: "" })) };
      const executor: Executor = {
        async execute({ worktreePath }) {
          await step(worktreePath);
          return {
            kind: "result",
            result: { status: "completed", summary: "s", filesChanged: [], testsAdded: [], blockedReason: "" },
          };
        },
      };
      const board = [
        { id: "ready", role: "approved" },
        { id: "doing", role: "active" },
        { id: "checking", role: "review" },
        { id: "shipped", role: "done" },
      ];
      const deps: PipelineDeps = {
        config: {
          apiBaseUrl: "http://localhost:3000",
          apiToken: "token",
          repoPath: parent,
          worktreeRoot: join(dir, "wt"),
          stateDir: join(dir, "state"),
          baseBranch: "main",
          pollIntervalMs: 1000,
          taskTimeoutMs: 900_000,
          runCeilingMs: 5_400_000,
          maxDiffLines: 400,
          maxDiffFiles: 10,
          workerId: "w",
        },
        api: {
          statusIds: async () => ({ approved: "ready", review: "checking", done: "shipped" }),
          comment: vi.fn(async () => {}),
          release: vi.fn(async () => {}),
        } as unknown as ApiClient,
        boardColumns: async () => board,
        createReporter: () => reporter,
        createDelivery: () => delivery,
        workspace: workspace(),
        executor,
        collectDiff: (runner, path, baseSha) => collectDiff(runner, gitPath, path, baseSha),
        gateFor: () => gate,
        runner: createRunner(),
        gitPath,
        recordRun: () => {},
        quarantineProject: () => {},
      };
      return { done: runTask(deps, task), reporter, delivery, gate };
    }

    it("refuses to commit what a step wrote through a rewritten .git file, and runs nothing after it", async () => {
      let fake = "";
      const h = run(async (path) => {
        fake = await redirectPointer(path, git(parent, "rev-parse", "refs/heads/main").trim(), false);
      });
      await h.done;

      expect(h.reporter.failed).toHaveBeenCalledTimes(1);
      expect(h.reporter.failed.mock.calls[0][1]).toContain(
        `refusing to stage: the checkout now has its .git file reading ${JSON.stringify(`gitdir: ${fake}`)}`,
      );
      expect(h.gate.run).not.toHaveBeenCalled();
      expect(h.delivery.push).not.toHaveBeenCalled();
      expect(git(parent, "rev-parse", "refs/heads/bp-1/worker").trim()).toBe(git(parent, "rev-parse", "refs/heads/main").trim());
      expect(readFileSync(join(fake, "refs", "heads", "bp-1", "worker"), "utf8").trim()).toBe(
        git(parent, "rev-parse", "refs/heads/main").trim(),
      );
    });

    it("refuses the run when a step hides an edit to a tracked file behind skip-worktree", async () => {
      const h = run(async (path) => {
        const pinned = { ...process.env, GIT_DIR: join(parent, ".git", "worktrees", "BP-1"), GIT_WORK_TREE: path };
        execFileSync("git", ["update-index", "--skip-worktree", "package.json"], { cwd: path, env: pinned });
        writeFileSync(join(path, "package.json"), '{"name":"t","scripts":{"postinstall":"sh x"}}\n');
      });
      await h.done;

      expect(h.reporter.failed.mock.calls[0]?.[1]).toContain("skip-worktree package.json");
      expect(h.gate.run).not.toHaveBeenCalled();
      expect(h.delivery.push).not.toHaveBeenCalled();
    });
  });
});
