import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "./api.js";
import { Delivery } from "./delivery.js";
import { collectDiff } from "./diff.js";
import { createRunner } from "./exec.js";
import { Executor } from "./executor.js";
import { PipelineDeps } from "./pipeline.js";
import { RepositoryRunDeps, runTaskInRepositories, SeveralRepositoriesDeps } from "./pipeline-several.js";
import { Reporter } from "./reporter.js";
import { ClaimedTask, Gate, SnapshotEntry } from "./types.js";
import { createWorkspace, PoisonedCheckoutError, Workspace } from "./workspace.js";
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

const COMPLETED = { status: "completed" as const, summary: "Changed it.", filesChanged: [], testsAdded: [], blockedReason: "" };
const READ: SnapshotEntry = { key: "read", kind: "step", name: "Read", prompt: "look", capability: "read-only" };
const IMPLEMENT: SnapshotEntry = { key: "implement", kind: "step", name: "Implement", prompt: "make the change", capability: "edit" };
const GATE: SnapshotEntry = { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" };
const PUSH: SnapshotEntry = { key: "push", kind: "step", name: "Push", deterministic: true };
const PR: SnapshotEntry = { key: "pull-request", kind: "step", name: "Pull request", deterministic: true };
const MERGE: SnapshotEntry = { key: "merge", kind: "step", name: "Merge", deterministic: true };

function taskWith(...sequence: SnapshotEntry[]): ClaimedTask {
  const base = claimedTask({ projectId: "p1", taskKey: "BP-1", taskNumber: 1 });
  return { ...base, agent: { ...base.agent, sequence } };
}

/**
 * BP-1072. A run across two real repositories: real clones, real linked worktrees, real commits and
 * real diffs. Only what has to be is stood in for: the agent (it writes files), the gates, delivery
 * to GitHub and the board.
 */
describe("a run across several repositories", () => {
  let dir: string;
  const names = ["api", "web"] as const;
  type Name = (typeof names)[number];
  let clones: Record<Name, string>;
  let origins: Record<Name, string>;

  function seedRepository(name: Name): void {
    const origin = join(dir, `${name}-origin.git`);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { stdio: "pipe" });
    const seed = join(dir, `${name}-seed`);
    execFileSync("git", ["init", "--quiet", "-b", "main", seed], { stdio: "pipe" });
    writeFileSync(join(seed, "package.json"), `{"name":"${name}"}\n`);
    writeFileSync(join(seed, "README.md"), `# ${name}\n`);
    writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "initial");
    git(seed, "push", "--quiet", origin, "HEAD:refs/heads/main");
    const clone = join(dir, name);
    execFileSync("git", ["clone", "--quiet", origin, clone], { stdio: "pipe" });
    origins[name] = origin;
    clones[name] = clone;
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bp1072-several-")));
    clones = {} as Record<Name, string>;
    origins = {} as Record<Name, string>;
    for (const name of names) seedRepository(name);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function build(over: {
    write?: (worktrees: Record<Name, string>, call: number) => void;
    gates?: Partial<Record<string, Gate["run"]>>;
    delivery?: Partial<Record<Name, Partial<Delivery>>>;
    createFails?: Name;
    signal?: AbortSignal;
    now?: () => number;
    ceilingMs?: number;
  } = {}) {
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
    const api = {
      comment: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      statusIds: vi.fn(async () => ({ approved: "todo", review: "in_review", done: "done" })),
    } as unknown as ApiClient;

    const deliveries = {} as Record<Name, Delivery>;
    const workspaces = {} as Record<Name, Workspace>;
    const quarantined: { index: number; reason: string }[] = [];
    const repositories: RepositoryRunDeps[] = names.map((name) => {
      const real = createWorkspace(
        workerConfig({ repoPath: clones[name], worktreeRoot: join(dir, "cp-worktrees"), baseBranch: "main" }),
        createRunner(),
        gitPath,
        () => ({}),
        origins[name],
        { name: "worker", email: "worker@example.com" },
      );
      const workspace: Workspace =
        over.createFails === name
          ? {
              ...real,
              create: async () => {
                throw new PoisonedCheckoutError("filter.x.smudge (local)");
              },
            }
          : real;
      workspaces[name] = workspace;
      const delivery: Delivery = {
        push: vi.fn(async () => {}),
        openPr: vi.fn(async () => `https://github.com/acme/${name}/pull/${name === "api" ? 3 : 9}`),
        merge: vi.fn(async () => {}),
        isPrivate: vi.fn(async () => false),
        linkRelated: vi.fn(async () => {}),
        ...over.delivery?.[name],
      };
      deliveries[name] = delivery;
      return {
        name,
        remote: origins[name],
        config: workerConfig({ repoPath: clones[name], worktreeRoot: join(dir, "cp-worktrees"), baseBranch: "main" }),
        workspace,
        createDelivery: () => delivery,
      };
    });

    const seen: { repositories?: { name: string; path: string }[]; cwd?: string }[] = [];
    const executor: Executor = {
      execute: vi.fn(async ({ repositories: refs, worktreePath }: Parameters<Executor["execute"]>[0]) => {
        seen.push({ repositories: refs?.map((r) => ({ name: r.name, path: r.path })), cwd: worktreePath });
        const byName = Object.fromEntries((refs ?? []).map((r) => [r.name, r.path])) as Record<Name, string>;
        over.write?.(byName, seen.length - 1);
        return { kind: "result" as const, result: COMPLETED };
      }),
    };

    const gateRuns: { gate: string; path: string }[] = [];
    const gateTimeouts: number[] = [];
    const gateFor: PipelineDeps["gateFor"] = (entry, _runner, timeoutMs) => (gateTimeouts.push(timeoutMs), {
      name: entry.name,
      run: async (context) => {
        gateRuns.push({ gate: entry.key, path: context.worktreePath });
        return over.gates?.[entry.key]?.(context) ?? { ok: true, reason: "" };
      },
    });

    const deps: SeveralRepositoriesDeps = {
      config: workerConfig({ worktreeRoot: join(dir, "api-wt"), repoPath: clones.api, ...(over.ceilingMs ? { runCeilingMs: over.ceilingMs } : {}) }),
      now: over.now,
      api,
      boardColumns: async () => [
        { id: "todo", role: "approved" },
        { id: "in_progress", role: "active" },
        { id: "in_review", role: "review" },
        { id: "done", role: "done" },
      ],
      createReporter: () => reporter,
      repositories,
      executor,
      collectDiff: (runner, path, baseSha) => collectDiff(runner, gitPath, path, baseSha),
      gateFor,
      gitPath,
      runner: createRunner(),
      recordRun: vi.fn(),
      signal: over.signal,
      logError: vi.fn(),
      quarantineCheckout: (_project, index, reason) => quarantined.push({ index, reason }),
    };
    return { deps, reporter, deliveries, workspaces, seen, gateRuns, gateTimeouts, quarantined };
  }

  const write = (path: string, file: string, text: string) => writeFileSync(join(path, file), text);
  // The linked worktrees a clone has, the main one not counted
  const linkedWorktrees = (name: Name) => git(clones[name], "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length - 1;
  const pushedTo = (run: ReturnType<typeof build>, name: Name) => vi.mocked(run.deliveries[name].push).mock.calls;

  it("commits and pushes each repository the agent changed, opens a pull request in each and lists them in one another", async () => {
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH, PR));

    for (const name of names) {
      expect(pushedTo(run, name)).toHaveLength(1);
      const [, branch, commit] = pushedTo(run, name)[0];
      expect(branch).toBe("bp-1/worker");
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    }
    const [url] = [run.reporter.delivered.mock.calls[0][1]];
    expect(url).toBe("https://github.com/acme/api/pull/3, https://github.com/acme/web/pull/9");
    expect(vi.mocked(run.deliveries.api.linkRelated)).toHaveBeenCalledWith(expect.any(String), "https://github.com/acme/api/pull/3", ["https://github.com/acme/web/pull/9"]);
    expect(vi.mocked(run.deliveries.web.linkRelated)).toHaveBeenCalledWith(expect.any(String), "https://github.com/acme/web/pull/9", ["https://github.com/acme/api/pull/3"]);
    expect(run.reporter.requeued).not.toHaveBeenCalled();
    expect(run.reporter.failed).not.toHaveBeenCalled();
  });

  it("hands the agent every worktree, the first one its working directory", async () => {
    const run = build({ write: (w) => write(w.api, "api.txt", "a\n") });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT));

    expect(run.seen).toHaveLength(1);
    expect(run.seen[0].repositories?.map((r) => r.name)).toEqual(["api", "web"]);
    expect(run.seen[0].cwd).toBe(run.seen[0].repositories?.[0].path);
    expect(new Set(run.seen[0].repositories?.map((r) => r.path)).size).toBe(2);
  });

  it("leaves a repository the agent did not change with no gate, no push and no pull request", async () => {
    const run = build({ write: (w) => write(w.api, "api.txt", "a\n") });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH, PR));

    expect(pushedTo(run, "web")).toHaveLength(0);
    expect(vi.mocked(run.deliveries.web.openPr)).not.toHaveBeenCalled();
    expect(run.gateRuns.map((g) => g.gate)).toEqual(["diff-size"]);
    expect(run.reporter.delivered.mock.calls[0][1]).toBe("https://github.com/acme/api/pull/3");
    // with one pull request there is nobody to list it with
    expect(vi.mocked(run.deliveries.api.linkRelated)).not.toHaveBeenCalled();
  });

  it("refuses a run in which the agent changed no repository, pushing nothing", async () => {
    const run = build();

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH));

    expect(run.reporter.gateRejected).toHaveBeenCalledWith(expect.anything(), "Size", expect.stringContaining("changed no repository"), "");
    for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
    // kept, for a person to look at
    expect(linkedWorktrees("api")).toBe(1);
    expect(linkedWorktrees("web")).toBe(1);
  });

  it("pushes nothing anywhere when a gate refuses the change in one repository, and says which", async () => {
    const run = build({
      write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); },
      gates: { "diff-size": async (context) => (existsSync(join(context.worktreePath, "web.txt")) ? { ok: false, reason: "too big" } : { ok: true, reason: "" }) },
    });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH, PR));

    for (const name of names) {
      expect(pushedTo(run, name)).toHaveLength(0);
      expect(vi.mocked(run.deliveries[name].openPr)).not.toHaveBeenCalled();
    }
    const [, gate, reason, branch] = run.reporter.gateRejected.mock.calls[0];
    expect(gate).toBe("Size");
    expect(reason).toContain("In web: too big");
    expect(reason).toContain("Nothing was pushed, in any repository");
    // no branch was pushed, so none is promised
    expect(branch).toBe("");
  });

  // The gates run entry by entry across the repositories, so the second repository's refusal is known
  // before anything of the first has been pushed
  it("runs a gate in every changed repository before the next entry", async () => {
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH));

    expect(run.gateRuns.map((g) => g.gate)).toEqual(["diff-size", "diff-size"]);
    expect(new Set(run.gateRuns.map((g) => g.path)).size).toBe(2);
  });

  describe("the run's ceiling across the repositories of one gate", () => {
    const MINUTE = 60_000;
    const twoChanged = (spend: number) => {
      let clock = 0;
      return build({
        now: () => clock,
        ceilingMs: 20 * MINUTE,
        write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); },
        gates: { "diff-size": async () => { clock += spend; return { ok: true, reason: "" }; } },
      });
    };

    it("cuts the second repository's time limit to what is left of the run", async () => {
      const run = twoChanged(15 * MINUTE);

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH));

      expect(run.gateTimeouts).toEqual([10 * MINUTE, 5 * MINUTE]);
      expect(run.gateRuns).toHaveLength(2);
    });

    it("hands the task back, pushing nothing, when the first repository's gate used the run up", async () => {
      const run = twoChanged(19.8 * MINUTE);

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH));

      expect(run.gateRuns).toHaveLength(1);
      expect(run.reporter.requeued).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("before the Size gate reached"));
      for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
    });
  });

  it("pushes nothing when the history of one repository is not what the run made", async () => {
    const run = build({
      write: (w) => {
        write(w.api, "api.txt", "a\n");
        write(w.web, "web.txt", "w\n");
      },
    });
    // The agent's step ends with a commit the worker did not make, in web only
    const executor = run.deps.executor;
    const original = executor.execute;
    executor.execute = async (options) => {
      const outcome = await original(options);
      const web = options.repositories?.find((r) => r.name === "web");
      if (web) {
        writeFileSync(join(web.path, "smuggled.txt"), "x\n");
        git(web.path, "add", "smuggled.txt");
        git(web.path, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "not the worker's");
      }
      return outcome;
    };

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH));

    for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
    expect(run.reporter.failed).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("refusing to push anything"));
  });

  describe("a repository the agent tampered with and never meant to change", () => {
    const rewritePointer = (w: Record<Name, string>) =>
      // A linked worktree's .git is a file; rewriting it is what BP-794 found a step could do
      writeFileSync(join(w.web, ".git"), "gitdir: /tmp/somewhere-else\n");

    // The step that wrote it also commits, in every repository, and the commit refuses first
    it("is found at the commit of the step that did it, in a repository it did not change", async () => {
      const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); rewritePointer(w); } });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, PUSH));

      expect(run.gateRuns).toEqual([]);
      for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
      expect(run.reporter.failed.mock.calls[0][1]).toMatch(/web/);
    });

    // A step that cannot commit has no commit to refuse in, so the next thing to look is the gate's vetting,
    // or the delivery's: each is exercised alone below
    const laterTamper = (w: Record<Name, string>, call: number) => {
      if (call === 0) write(w.api, "api.txt", "a\n");
      else rewritePointer(w);
    };

    it("is found before a gate runs anywhere", async () => {
      const run = build({ write: laterTamper });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, READ, GATE));

      expect(run.gateRuns).toEqual([]);
      expect(run.reporter.failed.mock.calls[0][1]).toContain("web worktree");
    });

    it("is found before a push, with no gate in the sequence", async () => {
      const run = build({ write: laterTamper });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, READ, PUSH));

      for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
      expect(run.reporter.failed.mock.calls[0][1]).toMatch(/refusing to push: the checkout now has web:/);
    });

    it("is found before the agent's next step is spawned", async () => {
      const run = build({ write: laterTamper });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, READ, READ));

      expect(run.seen).toHaveLength(2);
      expect(run.reporter.failed.mock.calls[0][1]).toMatch(/refusing to run Read: the checkout now has web:/);
    });
  });

  // Entry by entry: the second gate does not start in any repository until the first has finished in all
  it("runs the second gate in no repository until the first has run in every one", async () => {
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } });
    const SECOND: SnapshotEntry = { key: "test-presence", kind: "gate", name: "Tests", gateKind: "test-presence" };

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, GATE, SECOND));

    expect(run.gateRuns.map((g) => g.gate)).toEqual(["diff-size", "diff-size", "test-presence", "test-presence"]);
  });

  it("rolls back every worktree and quarantines the checkout that failed when one cannot be made", async () => {
    const run = build({ createFails: "web" });

    const disposition = await runTaskInRepositories(run.deps, taskWith(IMPLEMENT));

    expect(disposition).toBe("machine-fault");
    expect(run.quarantined).toEqual([{ index: 1, reason: expect.stringContaining("carries") }]);
    // the first repository's worktree is gone too
    expect(linkedWorktrees("api")).toBe(0);
    expect(linkedWorktrees("web")).toBe(0);
    expect(run.seen).toHaveLength(0);
    expect(run.reporter.released).toHaveBeenCalled();
  });

  it("merges in the project's order, and says what merged and what did not when one is refused", async () => {
    const run = build({
      write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); },
      delivery: { web: { merge: vi.fn(async () => { throw new Error("not mergeable"); }) } },
    });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR, MERGE));

    expect(vi.mocked(run.deliveries.api.merge)).toHaveBeenCalled();
    const message = run.reporter.failed.mock.calls[0][1];
    expect(message).toContain("web: Error: not mergeable");
    expect(message).toContain("Merged: api. Not merged: web.");
    expect(run.reporter.merged).not.toHaveBeenCalled();
  });

  it("reports a merge of every pull request as merged", async () => {
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR, MERGE));

    expect(run.reporter.merged).toHaveBeenCalledWith(expect.anything(), "https://github.com/acme/api/pull/3, https://github.com/acme/web/pull/9", "Changed it.");
    expect(run.reporter.delivered).not.toHaveBeenCalled();
  });

  describe("what one pull request says of the others", () => {
    const both = { write: (w: Record<Name, string>) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } };

    it("never puts a private repository's pull request into a public one's description", async () => {
      const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => false) }, web: { isPrivate: vi.fn(async () => true) } } });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

      // api is public: it does not name the private web. web is private: it may name the public api.
      expect(vi.mocked(run.deliveries.api.linkRelated)).not.toHaveBeenCalled();
      expect(vi.mocked(run.deliveries.web.linkRelated)).toHaveBeenCalledWith(expect.any(String), "https://github.com/acme/web/pull/9", ["https://github.com/acme/api/pull/3"]);
    });

    describe("the agent's summary", () => {
      const summaryOf = (run: ReturnType<typeof build>, name: Name) => vi.mocked(run.deliveries[name].openPr).mock.calls[0][2];

      it("goes into a pull request only when no private prose could be in it", async () => {
        const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => false) }, web: { isPrivate: vi.fn(async () => true) } } });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        // api is public and web is private: api's description is public and may not carry a summary of both
        expect(summaryOf(run, "api")).toContain("limited to this repository's own part");
        expect(summaryOf(run, "api")).not.toContain("Changed it.");
        // web is private: its readers may see everything
        expect(summaryOf(run, "web")).toBe("Changed it.");
      });

      it("goes into every pull request when every repository is public", async () => {
        const run = build({ ...both });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(summaryOf(run, "api")).toBe("Changed it.");
        expect(summaryOf(run, "web")).toBe("Changed it.");
      });

      it("is withheld from the pull request of a repository whose neighbour's visibility is unknown", async () => {
        const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => null) }, web: { isPrivate: vi.fn(async () => false) } } });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        // api (unknown) has only a public neighbour; web (public) has a neighbour not known to be public
        expect(summaryOf(run, "api")).toBe("Changed it.");
        expect(summaryOf(run, "web")).toContain("limited to this repository's own part");
      });

      it("treats a visibility lookup that throws as unknown", async () => {
        const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => { throw new Error("gh is down"); }) } } });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(summaryOf(run, "web")).toContain("limited to this repository's own part");
        expect(run.reporter.delivered).toHaveBeenCalled();
      });

      it("is asked of a repository the agent did not change too, because the agent read it", async () => {
        const run = build({
          write: (w) => write(w.api, "api.txt", "a\n"),
          delivery: { api: { isPrivate: vi.fn(async () => false) }, web: { isPrivate: vi.fn(async () => true) } },
        });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(vi.mocked(run.deliveries.web.isPrivate)).toHaveBeenCalled();
        expect(vi.mocked(run.deliveries.web.openPr)).not.toHaveBeenCalled();
        // api is public and the repository the agent read is private
        expect(summaryOf(run, "api")).toContain("limited to this repository's own part");
      });

      it("carries the summary of the only repository changed when the one the agent read is public", async () => {
        const run = build({ write: (w) => write(w.api, "api.txt", "a\n") });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(summaryOf(run, "api")).toBe("Changed it.");
      });

      it("trusts a verdict only while the checkout's origin is still the address the server named", async () => {
        const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => true) }, web: { isPrivate: vi.fn(async () => true) } } });
        // the origin moves between the inventory and the pull request, as an agent that can write the shared config would move it
        git(clones.api, "remote", "set-url", "origin", "https://github.com/elsewhere/api.git");

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(vi.mocked(run.deliveries.api.isPrivate)).not.toHaveBeenCalled();
        // api's verdict is unknown now, so web (private) may carry the summary and api (unknown) may not
        expect(summaryOf(run, "web")).toBe("Changed it.");
        expect(summaryOf(run, "api")).toContain("limited to this repository's own part");
      });

      it("is decided from the server's remote for each repository, before any pull request exists", async () => {
        const run = build({ ...both });

        await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

        expect(vi.mocked(run.deliveries.api.isPrivate)).toHaveBeenCalledWith(expect.any(String), origins.api);
        expect(vi.mocked(run.deliveries.web.isPrivate)).toHaveBeenCalledWith(expect.any(String), origins.web);
        const asked = Math.max(...names.map((name) => vi.mocked(run.deliveries[name].isPrivate).mock.invocationCallOrder[0]));
        const opened = Math.min(...names.map((name) => vi.mocked(run.deliveries[name].openPr).mock.invocationCallOrder[0]));
        expect(asked).toBeLessThan(opened);
      });
    });

    it("treats a repository whose visibility is unknown as public, and as not known to be public", async () => {
      const run = build({ ...both, delivery: { api: { isPrivate: vi.fn(async () => null) }, web: { isPrivate: vi.fn(async () => false) } } });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

      // api (unknown) may name web (known public); web (public) may not name api (unknown)
      expect(vi.mocked(run.deliveries.api.linkRelated)).toHaveBeenCalled();
      expect(vi.mocked(run.deliveries.web.linkRelated)).not.toHaveBeenCalled();
    });

    it("does not fail the run when a description cannot be edited, and says so on the board", async () => {
      const run = build({ ...both, delivery: { api: { linkRelated: vi.fn(async () => { throw new Error("rate limited"); }) } } });

      await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

      expect(run.reporter.delivered).toHaveBeenCalled();
      expect(run.reporter.noted).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Could not list the other pull requests"));
    });
  });

  it("destroys every worktree once the run has delivered", async () => {
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); write(w.web, "web.txt", "w\n"); } });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

    for (const name of names) expect(linkedWorktrees(name)).toBe(0);
  });

  it("stops between steps and hands the task back when the run is aborted", async () => {
    const controller = new AbortController();
    const run = build({ write: (w) => { write(w.api, "api.txt", "a\n"); controller.abort(); }, signal: controller.signal });

    await runTaskInRepositories(run.deps, taskWith(IMPLEMENT, PUSH, PR));

    expect(run.reporter.released).toHaveBeenCalled();
    for (const name of names) expect(pushedTo(run, name)).toHaveLength(0);
  });
});
