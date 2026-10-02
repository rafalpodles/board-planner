import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    seenAt: (created: string) => string = (created) => created,
  ) {
    const reporter = {
      blocked: vi.fn<Reporter["blocked"]>(async () => {}),
      gateRejected: vi.fn<Reporter["gateRejected"]>(async () => {}),
      released: vi.fn<Reporter["released"]>(async () => {}),
      requeued: vi.fn<Reporter["requeued"]>(async () => {}),
      merged: vi.fn<Reporter["merged"]>(async () => {}),
      delivered: vi.fn<Reporter["delivered"]>(async () => {}),
      failed: vi.fn<Reporter["failed"]>(async () => {}),
      noted: vi.fn<Reporter["noted"]>(async () => {}),
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
        return { ...created, path: seenAt(created.path) };
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

  const noted = (h: ReturnType<typeof run>) => h.reporter.noted.mock.calls.map((call) => call[1]);

  it("removes a test file the step wrote under an ignored dist/ before the Test gate, and carries on", async () => {
    let seenByTest: boolean | undefined;
    const h = run(
      [IMPLEMENT, TEST, PUSH],
      { implement: (path) => write(path, "dist/evil.test.js", "it('runs', () => {});\n") },
      { "test-run": (path) => (seenByTest = existsSync(join(path, "dist", "evil.test.js"))) },
    );
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.ran).toEqual(["test-run"]);
    expect(seenByTest).toBe(false);
    expect(h.delivery.push).toHaveBeenCalled();
    expect(noted(h)).toEqual([
      'Before the **Test** gate the worker removed 1 ignored file a step wrote, since no commit, diff or reviewer sees them and the gate could still run them: dist/evil.test.js (new; .gitignore:2: "dist/")',
    ]);
  });

  it("removes the node_modules the step's own npm install left, and the Build gate installs its own", async () => {
    let leftForBuild: boolean | undefined;
    const h = run(
      [IMPLEMENT, BUILD, TEST, PUSH],
      { implement: (path) => write(path, "node_modules/pkg/index.js", "module.exports = 'the step's';\n") },
      {
        build: (path) => {
          leftForBuild = existsSync(join(path, "node_modules", "pkg", "index.js"));
          write(path, "node_modules/pkg/index.js", "module.exports = 'the install's';\n");
        },
        "test-run": (path) => expect(readFileSync(join(path, "node_modules", "pkg", "index.js"), "utf8")).toContain("install"),
      },
    );
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(leftForBuild).toBe(false);
    expect(h.ran).toEqual(["build", "test-run"]);
    expect(h.delivery.push).toHaveBeenCalled();
    expect(noted(h)).toHaveLength(1);
    expect(noted(h)[0]).toMatch(/^Before the \*\*Build\*\* gate .*node_modules\/pkg\/index\.js \(new; \.gitignore:1: "node_modules\/"\)/);
  });

  it("removes one a later step added under a dist/ the Build gate had made, and keeps what the gate built", async () => {
    let state: { evil: boolean; built: boolean } | undefined;
    const h = run(
      [IMPLEMENT, BUILD, FIX, TEST, PUSH],
      { fix: (path) => write(path, "dist/evil.test.js", "it('runs', () => {});\n") },
      {
        build: (path) => write(path, "dist/main.js", "built\n"),
        "test-run": (path) =>
          (state = { evil: existsSync(join(path, "dist", "evil.test.js")), built: existsSync(join(path, "dist", "main.js")) }),
      },
    );
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(state).toEqual({ evil: false, built: true });
    expect(noted(h)[0]).toMatch(/^Before the \*\*Test\*\* gate .*: dist\/evil\.test\.js \(new; /);
  });

  it("still refuses a file the Build gate made that a later step rewrote, and removes nothing", async () => {
    let worktreePath = "";
    const h = run(
      [IMPLEMENT, BUILD, FIX, TEST, PUSH],
      {
        fix: (path) => {
          worktreePath = path;
          write(path, "dist/main.test.js", "it('runs', () => {});\n");
          write(path, "dist/evil.test.js", "it('runs', () => {});\n");
        },
      },
      { build: (path) => write(path, "dist/main.test.js", "built\n") },
    );
    await h.done;

    expect(h.ran).toEqual(["build"]);
    expect(h.reporter.noted).not.toHaveBeenCalled();
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(
      /^refusing to run the Test gate: ignored files written since .*: dist\/main\.test\.js \(changed; \.gitignore:2: "dist\/"\)/,
    );
    expect(existsSync(join(worktreePath, "dist", "evil.test.js"))).toBe(true);
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
    expect(h.reporter.noted).not.toHaveBeenCalled();
    expect(h.ran).toEqual(["build", "test-run"]);
    expect(h.delivery.push).toHaveBeenCalled();
  });

  it("leaves an ignored file that was there before the step ran", async () => {
    let present: boolean[] = [];
    const h = run(
      [IMPLEMENT, TEST, PUSH],
      {},
      { "test-run": (path) => (present = [".env", "dist/old.test.js"].map((file) => existsSync(join(path, file)))) },
      (path) => {
        write(path, ".env", "SECRET=1\n");
        write(path, "dist/old.test.js", "it('runs', () => {});\n");
      },
    );
    await h.done;

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.reporter.noted).not.toHaveBeenCalled();
    expect(present).toEqual([true, true]);
    expect(h.delivery.push).toHaveBeenCalled();
  });

  it("refuses the run, and removes nothing, when a file cannot be removed safely", async () => {
    let real = "";
    const h = run(
      [IMPLEMENT, TEST, PUSH],
      { implement: (path) => write(path, "dist/evil.test.js", "it('runs', () => {});\n") },
      {},
      () => {},
      (created) => {
        real = created;
        const linked = join(dir, "through-a-link");
        symlinkSync(created, linked);
        return linked;
      },
    );
    await h.done;

    expect(h.ran).toEqual([]);
    expect(h.reporter.noted).not.toHaveBeenCalled();
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(
      /^refusing to run the Test gate: ignored files a step wrote.*dist\/evil\.test\.js \(new; .*not every one could be removed safely: dist\/evil\.test\.js \(the worktree is not a directory\)/,
    );
    expect(existsSync(join(real, "dist", "evil.test.js"))).toBe(true);
  });
});
