import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "./api.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { Executor } from "./executor.js";
import { PipelineDeps, runTask } from "./pipeline.js";
import { Reporter } from "./reporter.js";
import { ClaimedTask, Gate, SnapshotEntry } from "./types.js";
import { createWorkspace, Workspace } from "./workspace.js";
import { installedToolPath } from "./__fixtures__/tool-paths.js";

const gitPath = installedToolPath("git");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "w", GIT_AUTHOR_EMAIL: "w@example.com", GIT_COMMITTER_NAME: "w", GIT_COMMITTER_EMAIL: "w@example.com" },
  }).toString();
}

function write(root: string, path: string, content: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

const IMPLEMENT: SnapshotEntry = { key: "implement", kind: "step", name: "Implement", prompt: "p", capability: "edit" };
const FIX: SnapshotEntry = { key: "fix", kind: "step", name: "Fix", prompt: "p", capability: "edit" };
const BUILD: SnapshotEntry = { key: "build", kind: "gate", name: "Build", gateKind: "build" };
const TEST: SnapshotEntry = { key: "test-run", kind: "gate", name: "Test", gateKind: "test-run" };
const PUSH: SnapshotEntry = { key: "push", kind: "step", name: "Push", deterministic: true };

/**
 * BP-795. A file the base commit's own `.gitignore` ignores reaches no diff, which BP-640 accepts so
 * node_modules and dist keep working — but the Test gate still runs one if the suite globs it. Real
 * git, a real linked worktree from the real createWorkspace, and the real runTask between them.
 */
describe("an ignored file a step wrote, before a gate runs it", () => {
  let dir: string;
  let parent: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp795-ignored-")));
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    const seed = join(dir, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    writeFileSync(join(seed, "package.json"), '{"name":"t"}\n');
    writeFileSync(join(seed, "index.ts"), "export {};\n");
    writeFileSync(join(seed, ".gitignore"), "node_modules/\ndist/\n.env\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    parent = join(dir, "parent");
    execFileSync("git", ["clone", "--quiet", origin, parent], { stdio: "pipe" });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    sequence: SnapshotEntry[],
    steps: Record<string, (path: string) => void>,
    gates: Record<string, (path: string) => void> = {},
    afterCreate: (path: string) => void = () => {},
  ) {
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
    const ran: string[] = [];
    const gateFor = (entry: SnapshotEntry): Gate => ({
      name: entry.name,
      run: async ({ worktreePath }) => {
        ran.push(entry.key);
        gates[entry.key]?.(worktreePath);
        return { ok: true, reason: "" };
      },
    });
    let stepsTaken = 0;
    const executor: Executor = {
      async execute({ worktreePath }) {
        stepsTaken += 1;
        write(worktreePath, "index.ts", `export const step = ${stepsTaken};\n`);
        steps[sequence.filter((entry) => entry.kind === "step" && entry.capability === "edit")[stepsTaken - 1].key]?.(worktreePath);
        return {
          kind: "result",
          result: { status: "completed", summary: "s", filesChanged: [], testsAdded: [], blockedReason: "" },
        };
      },
    };
    const real = createWorkspace(
      { repoPath: parent, worktreeRoot: join(dir, "wt"), baseBranch: "main" } as WorkerConfig,
      createRunner(),
      gitPath,
      () => ({}),
      join(dir, "origin.git"),
      { name: "worker", email: "worker@example.com" },
    );
    const workspace: Workspace = {
      ...real,
      async create(taskKey, slug) {
        const created = await real.create(taskKey, slug);
        afterCreate(created.path);
        return created;
      },
    };
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
      agent: { agentId: "a1", name: "a", sequence },
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
      workspace,
      executor,
      collectDiff: (runner, path, baseSha) => collectDiff(runner, gitPath, path, baseSha),
      gateFor,
      runner: createRunner(),
      gitPath,
      recordRun: () => {},
      quarantineProject: () => {},
    };
    return { done: runTask(deps, task), reporter, delivery, ran };
  }

  it("refuses the run before the Test gate, naming a test file the step wrote under an ignored dist/", async () => {
    const h = run([IMPLEMENT, TEST, PUSH], {
      implement: (path) => write(path, "dist/evil.test.js", "it('runs', () => {});\n"),
    });
    await h.done;

    expect(h.ran).toEqual([]);
    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.reporter.failed).toHaveBeenCalledTimes(1);
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(
      /^refusing to run the Test gate: ignored files written since the run started or the last gate passed.*dist\/evil\.test\.js \(new; \.gitignore:2: "dist\/"\)/,
    );
  });

  it("refuses one a later step added under a dist/ the Build gate had already made", async () => {
    const h = run(
      [IMPLEMENT, BUILD, FIX, TEST, PUSH],
      { fix: (path) => write(path, "dist/evil.test.js", "it('runs', () => {});\n") },
      { build: (path) => write(path, "dist/main.js", "built\n") },
    );
    await h.done;

    expect(h.ran).toEqual(["build"]);
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/dist\/evil\.test\.js \(new; /);
    expect(h.reporter.failed.mock.calls[0][1]).not.toMatch(/dist\/main\.js/);
  });

  it("refuses a file the Build gate made that a later step rewrote", async () => {
    const h = run(
      [IMPLEMENT, BUILD, FIX, TEST, PUSH],
      { fix: (path) => write(path, "dist/main.test.js", "it('runs', () => {});\n") },
      { build: (path) => write(path, "dist/main.test.js", "built\n") },
    );
    await h.done;

    expect(h.ran).toEqual(["build"]);
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/dist\/main\.test\.js \(changed; \.gitignore:2: "dist\/"\)/);
  });

  it("lets through the node_modules and dist a gate installed and built", async () => {
    const h = run(
      [IMPLEMENT, BUILD, TEST, PUSH],
      {},
      {
        build: (path) => {
          write(path, "node_modules/pkg/index.js", "module.exports = 1;\n");
          write(path, "node_modules/pkg/index.test.js", "it('runs', () => {});\n");
          write(path, "dist/main.js", "built\n");
        },
        "test-run": (path) => write(path, "node_modules/.vite/results.json", "{}\n"),
      },
    );
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.ran).toEqual(["build", "test-run"]);
    expect(h.delivery.push).toHaveBeenCalled();
  });

  it("lets through an ignored file that was there before the step ran", async () => {
    const h = run([IMPLEMENT, TEST, PUSH], {}, {}, (path) => {
      write(path, ".env", "SECRET=1\n");
      write(path, "dist/old.test.js", "it('runs', () => {});\n");
    });
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.ran).toEqual(["test-run"]);
    expect(h.delivery.push).toHaveBeenCalled();
  });
});
