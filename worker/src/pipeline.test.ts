import { describe, it, expect, vi } from "vitest";
import { ApiClient, StatusIds } from "./api.js";
import { SHUTDOWN_SIGNAL } from "./commands.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { CommandResult, Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { gitArgs } from "./git-safety.js";
import { Reporter } from "./reporter.js";
import { createTelemetry, isOutcome, isQuota, Progress, TelemetryUpdate } from "./telemetry.js";
import { BaseUnavailableError, Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, ExecutionResult, Gate, SnapshotEntry } from "./types.js";
import { PipelineDeps, resolveStatusIds, runTask } from "./pipeline.js";

// Exactly today's pipeline, expressed as an agent — the composition every existing project is
// backfilled with, so a task claimed here means what it has always meant.
const DEFAULT_SEQUENCE: SnapshotEntry[] = [
  { key: "implement", kind: "step", name: "Implement", prompt: "make the change", capability: "edit" },
  { key: "protected-paths", kind: "gate", name: "Protected files", gateKind: "protected-paths" },
  { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size" },
  { key: "test-presence", kind: "gate", name: "Test written", gateKind: "test-presence" },
  { key: "build", kind: "gate", name: "Builds", gateKind: "build" },
  { key: "test-run", kind: "gate", name: "Tests pass", gateKind: "test-run" },
  { key: "review", kind: "gate", name: "Reviewed", gateKind: "review" },
  { key: "push", kind: "step", name: "Push", deterministic: true },
  { key: "pull-request", kind: "step", name: "Pull request", deterministic: true },
];

function agentOf(sequence: SnapshotEntry[]) {
  return { agentId: "a1", name: "Default", sequence };
}

const task: ClaimedTask = {
  taskId: "t1",
  projectId: "CP",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "body",
  acceptanceCriteria: [],
  attempts: 1,
  runId: "run-1",
  agent: agentOf(DEFAULT_SEQUENCE),
};

const MERGE: SnapshotEntry = { key: "merge", kind: "step", name: "Merge", deterministic: true };

const KNOWN = new Map([...DEFAULT_SEQUENCE, MERGE].map((entry) => [entry.key, entry]));

/** The same task, running a different agent. An unknown key is a gate of its own kind. */
function running(...keys: string[]): ClaimedTask {
  return {
    ...task,
    agent: agentOf(keys.map((key) => KNOWN.get(key) ?? { key, kind: "gate", name: key, gateKind: key })),
  };
}

/** Everything the default does, and merges. What the "Merges its own work" agent is. */
const merging = running(...DEFAULT_SEQUENCE.map((entry) => entry.key), "merge");

const completed: ExecutionResult = {
  status: "completed",
  summary: "did it",
  filesChanged: ["a.ts"],
  testsAdded: ["a.test.ts"],
  blockedReason: "",
};

// Deliberately none of the seeded ids, so any surviving literal fails
const statuses: StatusIds = { approved: "ready", review: "checking", done: "shipped" };
const board = ["ready", "doing", "checking", "shipped"];

const diff: DiffStats = { changedLines: 10, changedFiles: ["a.ts"], patch: "d", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" };

const config: WorkerConfig = {
  apiBaseUrl: "http://localhost:3000",
  apiToken: "token",
  repoPath: "/repo",
  worktreeRoot: "/worktrees",
  stateDir: "/state",
  baseBranch: "main",
  pollIntervalMs: 1000,
  taskTimeoutMs: 900_000,
  runCeilingMs: 5_400_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  workerId: "worker-test",
};

function shell(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
}

const IMPLEMENT_COMMIT_SHA = "sha-implement001";

// A worktree that starts dirty, the way the implement step actually leaves one, and goes clean the
// moment commitAll's own `git commit` runs — so the sha it hands back is what reaches push, and the
// unfinishedWork check right after it does not mistake the just-committed tree for leftover work.
function defaultRunner(): { run: ReturnType<typeof vi.fn> } {
  let committed = false;
  const run = vi.fn<Runner["run"]>(async (_command, args) => {
    if (args.includes("status")) return shell(committed ? "" : " M a.ts\n");
    if (args.includes("commit")) {
      committed = true;
      return shell();
    }
    // The provenance guard's range: exactly the commit the mock above made, once it made it.
    if (args.includes("rev-list")) return shell(committed ? `${IMPLEMENT_COMMIT_SHA}\n` : "");
    if (args.includes("rev-parse")) return shell(IMPLEMENT_COMMIT_SHA);
    return shell();
  });
  return { run };
}

function passingGate(name: string) {
  return { name, run: vi.fn<Gate["run"]>().mockResolvedValue({ ok: true, reason: "" }) };
}

function rejectingGate(name: string, reason: string) {
  return { name, run: vi.fn<Gate["run"]>().mockResolvedValue({ ok: false, reason }) };
}

function deliverySpy(overrides: Partial<Delivery> = {}) {
  return {
    push: vi.fn<Delivery["push"]>().mockResolvedValue(undefined),
    openPr: vi.fn<Delivery["openPr"]>().mockResolvedValue("https://x/pull/7"),
    merge: vi.fn<Delivery["merge"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function harness(overrides: Partial<PipelineDeps> = {}) {
  const api = {
    claim: vi.fn<ApiClient["claim"]>().mockResolvedValue(null),
    setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
    comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
    release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
    statusIds: vi.fn<ApiClient["statusIds"]>().mockResolvedValue(statuses),
    columnIds: vi.fn<ApiClient["columnIds"]>().mockResolvedValue(board),
    postEvent: vi.fn<ApiClient["postEvent"]>().mockResolvedValue({ applied: true }),
    postRun: vi.fn<ApiClient["postRun"]>().mockResolvedValue(undefined),
  };
  const columnIds = vi.fn<PipelineDeps["columnIds"]>().mockResolvedValue(board);
  const reporter = {
    blocked: vi.fn<Reporter["blocked"]>().mockResolvedValue(undefined),
    gateRejected: vi.fn<Reporter["gateRejected"]>().mockResolvedValue(undefined),
    released: vi.fn<Reporter["released"]>().mockResolvedValue(undefined),
    requeued: vi.fn<Reporter["requeued"]>().mockResolvedValue(undefined),
    merged: vi.fn<Reporter["merged"]>().mockResolvedValue(undefined),
    delivered: vi.fn<Reporter["delivered"]>().mockResolvedValue(undefined),
    failed: vi.fn<Reporter["failed"]>().mockResolvedValue(undefined),
  };
  const createReporter = vi.fn<PipelineDeps["createReporter"]>(() => reporter);
  const delivery = deliverySpy();
  const createDelivery = vi.fn<PipelineDeps["createDelivery"]>(() => delivery);
  const workspace = {
    create: vi.fn<Workspace["create"]>().mockResolvedValue({ path: "/wt", baseSha: "base1" }),
    destroy: vi.fn<Workspace["destroy"]>().mockResolvedValue(undefined),
    listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
  };
  const executor = {
    execute: vi
      .fn<Executor["execute"]>()
      .mockResolvedValue({ kind: "result", result: completed }),
  };
  const collectDiff = vi.fn<PipelineDeps["collectDiff"]>().mockResolvedValue(diff);
  const runner = defaultRunner();
  // Every gate passes unless a test says otherwise. What each kind actually does is
  // gates/from-entry.test.ts's subject; this file is about the order they run in.
  const gateFor = vi.fn<PipelineDeps["gateFor"]>((entry) => passingGate(entry.key));
  const recordRun = vi.fn<PipelineDeps["recordRun"]>();

  const deps: PipelineDeps = {
    config,
    api,
    columnIds,
    createReporter,
    createDelivery,
    workspace,
    executor,
    collectDiff,
    gateFor,
    recordRun,
    runner,
    ...overrides,
  };

  return {
    deps,
    api,
    columnIds,
    reporter,
    createReporter,
    delivery,
    createDelivery,
    workspace,
    executor,
    collectDiff,
    gateFor,
    recordRun,
    runner,
  };
}

/** A gateFor that answers with the given gate for one key, and passes everything else. */
function gateForOnly(key: string, gate: Gate): PipelineDeps["gateFor"] {
  return (entry) => (entry.key === key ? gate : passingGate(entry.key));
}

// reporter.gateRejected is mocked throughout this file, so nothing here exercises reporter.ts's
// own composition. This mirrors it (reporter.ts:107-116) to catch pipeline.ts handing it a branch
// that contradicts the reason it just gave — reporter.ts's own comment names the hazard directly.
function composedGateRejectedComment(call: unknown[]): string {
  const [, gate, reason, branch] = call as [ClaimedTask, string, string, string];
  const where = branch ? `\n\nThe work is pushed to \`${branch}\` for inspection.` : "";
  return `The execution worker blocked the merge at the **${gate}** gate.\n\n${reason}${where}`;
}

describe("resolveStatusIds", () => {
  it("returns the ids when every role maps to a column the board carries", async () => {
    const resolved = await resolveStatusIds(
      { statusIds: vi.fn<ApiClient["statusIds"]>().mockResolvedValue(statuses) },
      async () => board,
      "CP"
    );

    expect(resolved).toEqual(statuses);
  });

  it("names every role the board cannot route", async () => {
    const promise = resolveStatusIds(
      { statusIds: vi.fn<ApiClient["statusIds"]>().mockResolvedValue(statuses) },
      async () => ["ready", "doing"],
      "CP"
    );

    await expect(promise).rejects.toThrow(/checking/);
    await expect(promise).rejects.toThrow(/shipped/);
  });
});

describe("runTask", () => {
  it("merges and reports done on the happy path, pushing the sha the implement step committed", async () => {
    const h = harness();
    await runTask(h.deps, merging);

    expect(h.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker", IMPLEMENT_COMMIT_SHA);
    expect(h.delivery.openPr).toHaveBeenCalledWith("/wt", merging, "did it");
    expect(h.delivery.merge).toHaveBeenCalledWith("/wt", "https://x/pull/7");
    expect(h.reporter.merged).toHaveBeenCalledWith(merging, "https://x/pull/7", "did it");
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("opens the pull request against the configured base branch", async () => {
    const h = harness({ config: { ...config, baseBranch: "develop" } });
    await runTask(h.deps, task);

    expect(h.createDelivery).toHaveBeenCalledWith(h.runner, "develop");
  });

  it("diffs against the worktree's captured base sha, not the configured branch name", async () => {
    const h = harness({ config: { ...config, baseBranch: "develop" } });
    h.workspace.create.mockResolvedValue({ path: "/wt", baseSha: "base111" });
    await runTask(h.deps, task);

    expect(h.collectDiff).toHaveBeenCalledWith(h.runner, "/wt", "base111");
  });

  // A base that could not be established is the machine's failure, not the task's. requeued charges
  // the attempt and nothing ever resets execution.attempts, so charging one unreachable remote to
  // the queue parks every task in it in front of a human, permanently, for a network problem.
  it("releases the task with its attempt refunded when the base cannot be established", async () => {
    const h = harness();
    h.workspace.create.mockRejectedValue(
      new BaseUnavailableError("could not resolve base branch main: no route to host")
    );

    const disposition = await runTask(h.deps, task);

    expect(disposition).toBe("machine-fault");
    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
    expect(h.reporter.released.mock.calls[0][1]).toMatch(/no route to host/);
  });

  // The other half of the taxonomy. A remote that answers and reports no such ref is this project's
  // configuration — a default branch of master under a policy default of main, a branch renamed
  // away, an empty repository. Refunding that would circle the task through the approved column for
  // ever with nothing on the machine able to fix it, and would end every pass on a project that is
  // merely misconfigured. It spends the attempt so a human eventually sees it.
  it("charges the attempt, and reports no machine fault, when the remote has no such base branch", async () => {
    const h = harness();
    h.workspace.create.mockRejectedValue(
      new BaseUnavailableError(
        "could not resolve base branch main: ssh://git@github.com/x/y did not report refs/heads/main",
        "configuration"
      )
    );

    const disposition = await runTask(h.deps, task);

    expect(disposition).toBeUndefined();
    expect(h.reporter.requeued).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/did not report refs\/heads\/main/);
  });

  it("writes the machine fault to the worker's own log, not only to the board", async () => {
    const logError = vi.fn();
    const h = harness({ logError });
    h.workspace.create.mockRejectedValue(new BaseUnavailableError("no route to host"));

    await runTask(h.deps, task);

    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/CP-158.*no route to host/));
  });

  // Everything else that can go wrong creating a worktree is still the task's problem and still
  // spends the attempt — a task whose own key or branch breaks the worktree must run out of retries.
  it("still charges the attempt when the worktree fails for a reason that is not the base", async () => {
    const h = harness();
    h.workspace.create.mockRejectedValue(new Error("worktree add failed"));

    const disposition = await runTask(h.deps, task);

    expect(disposition).toBeUndefined();
    expect(h.reporter.requeued).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
  });

  it("resolves the board and builds a reporter for every task, not once per process", async () => {
    const h = harness();
    await runTask(h.deps, task);
    await runTask(h.deps, task);

    expect(h.api.statusIds).toHaveBeenCalledTimes(2);
    expect(h.columnIds).toHaveBeenCalledTimes(2);
    expect(h.createReporter).toHaveBeenCalledTimes(2);
    expect(h.createReporter).toHaveBeenCalledWith(h.api, statuses);
  });

  it("does no work on a board that cannot route the outcome and hands the task back", async () => {
    const columnIds = vi
      .fn<PipelineDeps["columnIds"]>()
      .mockResolvedValue(["ready", "doing", "checking"]);
    const h = harness({ columnIds });
    await runTask(h.deps, task);

    expect(h.workspace.create).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect(h.api.release).toHaveBeenCalledWith("CP", "t1");
    expect(h.api.comment.mock.calls[0][2]).toMatch(/shipped/);
  });

  // This comment is posted directly, before a reporter exists to scrub it
  it("redacts a credential in the error it comments when the board cannot be resolved", async () => {
    const credential = `cpw_${"9f3c".repeat(16)}`;
    const h = harness();
    h.api.statusIds.mockRejectedValue(new Error(`401 for worker w1 with credential ${credential}`));

    await runTask(h.deps, task);

    const body = h.api.comment.mock.calls[0][2];
    expect(body).not.toContain(credential);
    expect(body).not.toContain("cpw_");
    expect(body).toContain("Returned to the queue");
    expect(body).toContain("401 for worker w1 with credential [redacted]");
  });

  it("releases the task back to the queue on a usage limit", async () => {
    const execute = vi.fn<Executor["execute"]>().mockResolvedValue({ kind: "usage_limit" });
    const h = harness({ executor: { execute } });
    await runTask(h.deps, task);

    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.delivery.merge).not.toHaveBeenCalled();
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("requeues a timed-out run and charges it the attempt, so retries terminate", async () => {
    const execute = vi.fn<Executor["execute"]>().mockResolvedValue({ kind: "timeout" });
    const h = harness({ executor: { execute } });
    await runTask(h.deps, task);

    expect(h.reporter.requeued).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
    expect(h.reporter.failed).not.toHaveBeenCalled();
  });

  it("requeues an executor error rather than spending a human on a crash", async () => {
    const execute = vi
      .fn<Executor["execute"]>()
      .mockResolvedValue({ kind: "error", message: "could not parse claude output" });
    const h = harness({ executor: { execute } });
    await runTask(h.deps, task);

    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/could not parse claude output/);
    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
  });

  it("requeues an unexpected error from anywhere in the run", async () => {
    const collectDiff = vi.fn<PipelineDeps["collectDiff"]>().mockRejectedValue(new Error("boom"));
    const h = harness({ collectDiff });
    await runTask(h.deps, task);

    expect(h.reporter.requeued).toHaveBeenCalled();
    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/boom/);
  });

  it("reports blocked without opening a pr", async () => {
    const blocked: ExecutionResult = { ...completed, status: "blocked", blockedReason: "ambiguous" };
    const execute = vi
      .fn<Executor["execute"]>()
      .mockResolvedValue({ kind: "result", result: blocked });
    const h = harness({ executor: { execute } });
    await runTask(h.deps, task);

    expect(h.reporter.blocked).toHaveBeenCalledWith(task, "ambiguous");
    expect(h.delivery.openPr).not.toHaveBeenCalled();
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("refuses to gate a worktree the executor left dirty, and keeps it for a human", async () => {
    const runner = {
      run: vi.fn<Runner["run"]>().mockResolvedValue(shell("?? .claude/settings.json\n")),
    };
    const gate = passingGate("diff-size");
    const h = harness({ runner, gateFor: () => gate });
    await runTask(h.deps, running("implement", "diff-size"));

    expect(runner.run).toHaveBeenCalledWith(
      "git",
      gitArgs(["status", "--porcelain"]),
      expect.objectContaining({
        cwd: "/wt",
        env: expect.objectContaining({ GIT_CONFIG_NOSYSTEM: "1" }),
      })
    );
    expect(h.collectDiff).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/\.claude\/settings\.json/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  // The commit's own status has to succeed first, or commitAll fails and this never reaches the
  // check it is named after — which is exactly how it passed while asserting nothing
  it("treats a worktree whose state cannot be read as dirty", async () => {
    let calls = 0;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        // The pre-staging config scan (BP-403) is not one of the calls this fixture counts
        if (args.includes("--list")) return shell("");
        calls += 1;
        return calls === 1
          ? shell("")
          : shell("", { code: 128, stderr: "not a git repository" });
      }),
    };
    const h = harness({ runner });
    await runTask(h.deps, running("implement", "diff-size"));

    expect(h.collectDiff).not.toHaveBeenCalled();
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/not a git repository/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  // The agent has no Bash any more, so nothing but this puts its work in a commit
  it("commits what the agent wrote, under the task key", async () => {
    const runner = { run: vi.fn<Runner["run"]>().mockResolvedValue(shell(" M src/a.ts\n")) };
    const h = harness({ runner });
    await runTask(h.deps, running("implement"));

    const commit = runner.run.mock.calls.find(([, args]) => args.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit![1][commit![1].indexOf("-m") + 1]).toMatch(/^CP-158: /);
  });

  it("does not commit a run the agent reported blocked", async () => {
    const runner = { run: vi.fn<Runner["run"]>().mockResolvedValue(shell(" M src/a.ts\n")) };
    const executor = {
      execute: vi.fn<Executor["execute"]>().mockResolvedValue({
        kind: "result",
        result: { ...completed, status: "blocked", blockedReason: "unclear" },
      }),
    };
    const h = harness({ runner, executor });
    await runTask(h.deps, running("implement"));

    expect(runner.run.mock.calls.some(([, args]) => args.includes("commit"))).toBe(false);
  });

  it("runs the gates on a clean worktree", async () => {
    const gate = passingGate("diff-size");
    const h = harness({ gateFor: gateForOnly("diff-size", gate) });
    await runTask(h.deps, merging);

    expect(gate.run).toHaveBeenCalledWith({
      worktreePath: "/wt",
      task: merging,
      result: completed,
      diff,
    });
    expect(h.reporter.merged).toHaveBeenCalled();
  });

  it("stops at the first failing gate and names it", async () => {
    const failing = rejectingGate("diff-size", "too big");
    const later = passingGate("review");
    const h = harness({
      gateFor: (entry) => (entry.key === "diff-size" ? failing : later),
    });
    await runTask(h.deps, running("implement", "diff-size", "review"));

    expect(h.reporter.gateRejected).toHaveBeenCalledWith(
      running("implement", "diff-size", "review"),
      "diff-size",
      "too big",
      "cp-158/worker",
      // The refused change travels with the refusal now; the reporter only renders it where no
      // branch carries it, which for this gate is not the case.
      expect.anything()
    );
    expect(later.run).not.toHaveBeenCalled();
    expect(h.delivery.merge).not.toHaveBeenCalled();
  });

  it("stops between phases without starting the next gate", async () => {
    const controller = new AbortController();
    const later = { name: "build", run: vi.fn() };
    const first = {
      name: "diff-size",
      run: vi.fn(async () => {
        controller.abort();
        return { ok: true, reason: "" };
      }),
    };
    const h = harness({
      gateFor: (entry) => (entry.key === "diff-size" ? first : later),
      signal: controller.signal,
    });

    await runTask(h.deps, running("implement", "diff-size", "build"));

    expect(later.run).not.toHaveBeenCalled();
    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
  });

  // A killed agent settles as an ordinary failed run, so without a check here the operator's stop
  // is charged to the task and three of them park it in review as "gave up on attempt 3"
  it("releases without charging the attempt when the stop lands inside the agent run", async () => {
    const controller = new AbortController();
    const execute = vi.fn<Executor["execute"]>(async () => {
      controller.abort();
      return { kind: "error", message: "AbortError: The operation was aborted" };
    });
    const h = harness({ executor: { execute }, signal: controller.signal });

    await runTask(h.deps, task);

    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
  });

  // A supervisor restarting the worker on a failing health check signals it every cycle. Refunding
  // there means claim(+1), abort, refund(-1), restart, re-claim the same task — attempts never
  // grow, so the task never runs out of retries and never reaches a human, which is the entire
  // point of counting them.
  it("charges the attempt when a process signal stopped the run, not an operator", async () => {
    const controller = new AbortController();
    const execute = vi.fn<Executor["execute"]>(async () => {
      controller.abort(SHUTDOWN_SIGNAL);
      return { kind: "error", message: "AbortError: The operation was aborted" };
    });
    const h = harness({ executor: { execute }, signal: controller.signal });

    await runTask(h.deps, task);

    expect(h.reporter.requeued).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
  });

  // Same shape one phase later: the gate's own subprocess is killed, so the gate reports a
  // perfectly ordinary "build failed (exit -1)" and the board would blame the change for it
  it("releases and pushes nothing when the stop lands inside a gate's own subprocess", async () => {
    const controller = new AbortController();
    const gate = {
      name: "build",
      run: vi.fn<Gate["run"]>(async () => {
        controller.abort();
        return { ok: false, reason: "build failed (exit -1)" };
      }),
    };
    const h = harness({ gateFor: () => gate, signal: controller.signal });

    await runTask(h.deps, running("implement", "build"));

    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.gateRejected).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
  });

  it("names the pushed branch when the stop lands between the push and the pull request", async () => {
    const controller = new AbortController();
    const delivery = deliverySpy({
      push: vi.fn<Delivery["push"]>(async () => {
        controller.abort();
      }),
    });
    const h = harness({
      createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery),
      signal: controller.signal,
    });

    await runTask(h.deps, merging);

    expect(h.reporter.released.mock.calls[0][1]).toMatch(/cp-158\/worker/);
    expect(delivery.openPr).not.toHaveBeenCalled();
  });

  it("names the open pull request when the stop lands between it and the merge", async () => {
    const controller = new AbortController();
    const delivery = deliverySpy({
      openPr: vi.fn<Delivery["openPr"]>(async () => {
        controller.abort();
        return "https://x/pull/7";
      }),
    });
    const h = harness({
      createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery),
      signal: controller.signal,
    });

    await runTask(h.deps, merging);

    const reason = h.reporter.released.mock.calls[0][1];
    expect(reason).toMatch(/cp-158\/worker/);
    expect(reason).toMatch(/https:\/\/x\/pull\/7/);
    expect(delivery.merge).not.toHaveBeenCalled();
  });

  it("passes the signal to the executor, so a stop can reach the run in flight", async () => {
    const controller = new AbortController();
    const execute = vi
      .fn<Executor["execute"]>()
      .mockResolvedValue({ kind: "result", result: completed });
    const h = harness({ executor: { execute }, signal: controller.signal });

    await runTask(h.deps, task);

    expect(execute.mock.calls[0][0]).toMatchObject({
      task,
      worktreePath: "/wt",
      signal: controller.signal,
    });
  });

  it("gives every gate the signal, so a build or review gate can honour a stop", async () => {
    const controller = new AbortController();
    const gate = passingGate("build");
    const h = harness({ gateFor: () => gate, signal: controller.signal });

    await runTask(h.deps, running("implement", "build"));

    expect(gate.run).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it("stops before delivery when the signal aborts after the last gate passes", async () => {
    const controller = new AbortController();
    const gate = {
      name: "review",
      run: vi.fn(async () => {
        controller.abort();
        return { ok: true, reason: "" };
      }),
    };
    const h = harness({ gateFor: () => gate, signal: controller.signal });

    await runTask(h.deps, running("implement", "review", "push"));

    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.merged).not.toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
  });

  it("pushes the rejected branch before discarding the worktree, naming the sha it committed", async () => {
    const h = harness({ gateFor: () => rejectingGate("diff-size", "too big") });
    await runTask(h.deps, running("implement", "diff-size"));

    expect(h.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker", IMPLEMENT_COMMIT_SHA);
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  // Every other test in this file runs a single writing step, where commits[0] and the last commit
  // are the same value — so none of them can tell a correct index from a stale one. Two writing
  // steps is the smallest arrangement where the difference exists at all.
  it("pushes the last commit the run made, not its first, when a gate rejects after two writing steps", async () => {
    const FIRST = "sha-first00001";
    const LAST = "sha-last000001";
    let statusCalls = 0;
    let commitsMade = 0;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        // dirty before each commit, clean at the check that follows it
        if (args.includes("status")) {
          statusCalls += 1;
          return shell(statusCalls % 2 === 1 ? " M a.ts\n" : "");
        }
        if (args.includes("commit")) {
          commitsMade += 1;
          return shell();
        }
        // the provenance guard's range: newest first, exactly the commits made so far
        if (args.includes("rev-list")) {
          return shell(commitsMade >= 2 ? `${LAST}\n${FIRST}\n` : commitsMade === 1 ? `${FIRST}\n` : "");
        }
        if (args.includes("rev-parse")) return shell(commitsMade >= 2 ? LAST : FIRST);
        return shell();
      }),
    };
    const second: SnapshotEntry = {
      key: "polish",
      kind: "step",
      name: "Polish",
      prompt: "tidy it",
      capability: "edit",
    };
    const h = harness({ runner, gateFor: () => rejectingGate("diff-size", "too big") });
    const twoWrites = {
      ...task,
      agent: agentOf([
        KNOWN.get("implement")!,
        second,
        { key: "diff-size", kind: "gate", name: "diff-size", gateKind: "diff-size" },
      ]),
    };

    await runTask(h.deps, twoWrites);

    expect(h.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker", LAST);
  });

  it("says so in the comment and keeps the worktree when the rejected branch will not push", async () => {
    const delivery = deliverySpy({
      push: vi.fn<Delivery["push"]>().mockRejectedValue(new Error("stale info")),
    });
    const h = harness({
      createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery),
      gateFor: () => rejectingGate("diff-size", "too big"),
    });
    await runTask(h.deps, running("implement", "diff-size"));

    const call = h.reporter.gateRejected.mock.calls[0];
    const [, , reason, branch] = call;
    expect(reason).toMatch(/too big/);
    expect(reason).toMatch(/stale info/);
    expect(reason).toMatch(/not on the remote/);
    // The bug this guards: a failed push must not also promise the branch is there to inspect.
    expect(branch).toBe("");
    expect(composedGateRejectedComment(call)).not.toMatch(/is pushed to/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("refuses to push the rejected branch too when the range carries a commit this run did not make", async () => {
    let committed = false;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        if (args.includes("status")) return shell(committed ? "" : " M a.ts\n");
        if (args.includes("commit")) {
          committed = true;
          return shell();
        }
        // A foreign sha alongside the real one — planted the way an agent with Write under .git
        // could, not something this run's own commit() calls ever produced.
        if (args.includes("rev-list")) return shell(`shaX\n${IMPLEMENT_COMMIT_SHA}\n`);
        if (args.includes("rev-parse")) return shell(IMPLEMENT_COMMIT_SHA);
        return shell();
      }),
    };
    const h = harness({ runner, gateFor: () => rejectingGate("diff-size", "too big") });
    await runTask(h.deps, running("implement", "diff-size"));

    expect(h.delivery.push).not.toHaveBeenCalled();
    const call = h.reporter.gateRejected.mock.calls[0];
    const [, , reason, branch] = call;
    expect(reason).toMatch(/too big/);
    expect(reason).toMatch(/refusing to push/);
    expect(reason).toMatch(/shaX/);
    expect(reason).toMatch(/not on the remote/);
    expect(branch).toBe("");
    expect(composedGateRejectedComment(call)).not.toMatch(/is pushed to/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("returns the task to the queue when a gate could not run because of a usage limit", async () => {
    const gate = rejectingGate(
      "review",
      "the review could not be completed: claude exited 1\nClaude AI usage limit reached|1754006400"
    );
    const h = harness({ gateFor: () => gate });
    await runTask(h.deps, running("implement", "review"));

    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.gateRejected).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
  });

  it("still rejects a verdict that merely talks about a usage limit", async () => {
    const gate = rejectingGate(
      "review",
      "the reviewer rejected the change: it deletes the usage limit reached branch"
    );
    const h = harness({ gateFor: () => gate });
    await runTask(h.deps, running("implement", "review"));

    expect(h.reporter.gateRejected).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
  });

  it("destroys the worktree and requeues when a gate throws", async () => {
    const exploding = { name: "build", run: vi.fn<Gate["run"]>().mockRejectedValue(new Error("boom")) };
    const h = harness({ gateFor: () => exploding });
    await runTask(h.deps, running("implement", "build"));

    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/boom/);
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("keeps the worktree and names the branch and the pr when the merge fails", async () => {
    const delivery = deliverySpy({
      merge: vi.fn<Delivery["merge"]>().mockRejectedValue(new Error("not mergeable")),
    });
    const h = harness({ createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery) });
    await runTask(h.deps, merging);

    const reason = h.reporter.failed.mock.calls[0][1];
    expect(reason).toMatch(/not mergeable/);
    expect(reason).toMatch(/Merge failed/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("names only the branch when the delivery push fails before any pr exists", async () => {
    const delivery = deliverySpy({
      push: vi.fn<Delivery["push"]>().mockRejectedValue(new Error("permission denied")),
    });
    const h = harness({ createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery) });
    await runTask(h.deps, merging);

    const reason = h.reporter.failed.mock.calls[0][1];
    expect(reason).toMatch(/permission denied/);
    expect(reason).toMatch(/Push failed/);
    expect(delivery.openPr).not.toHaveBeenCalled();
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("never rejects, even when the cleanup itself throws", async () => {
    const workspace = {
      create: vi.fn<Workspace["create"]>().mockResolvedValue({ path: "/wt", baseSha: "base1" }),
      destroy: vi.fn<Workspace["destroy"]>(() => {
        throw new Error("worktree is locked");
      }),
      listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
    };
    const h = harness({ workspace });

    await expect(runTask(h.deps, merging)).resolves.toBeUndefined();
    expect(h.reporter.merged).toHaveBeenCalled();
  });

  it("runs the entries in the order the agent lists them", async () => {
    const seen: string[] = [];
    const h = harness({
      gateFor: (entry) => ({
        name: entry.key,
        run: vi.fn(async () => {
          seen.push(`gate:${entry.key}`);
          return { ok: true, reason: "" };
        }),
      }),
      executor: {
        execute: vi.fn<Executor["execute"]>(async () => {
          seen.push("step:implement");
          return { kind: "result", result: completed };
        }),
      },
    });

    await runTask(h.deps, running("review", "implement", "diff-size"));

    expect(seen).toEqual(["gate:review", "step:implement", "gate:diff-size"]);
  });

  // Skipping it would run a shorter agent than the one somebody composed, and a missing check looks
  // exactly like a check that passed
  it("refuses a gate kind this worker does not implement, naming it", async () => {
    const h = harness({ gateFor: () => null });
    await runTask(h.deps, running("implement", "invented"));

    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/invented/);
    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  // With several writing steps an unclean tree poisons everything after it, so the check runs after
  // each of them rather than once after the first
  it("ends the run when a later writing step leaves the tree unclean", async () => {
    let calls = 0;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        // The pre-staging config scan is not one of the calls this fixture counts. Skipped by
        // shape rather than counted: BP-403 added one call to it and BP-346 a second, and each
        // time the numbering below moved while still reading as though it named the checks
        if (args.includes("--list")) return shell("");
        calls += 1;
        // 1: the first commit's status, 2: the check after step one, 3: the second commit's status,
        // 4: the check after step two — the one that only exists because steps can follow steps
        return shell(calls >= 4 ? " M src/a.ts\n" : "");
      }),
    };
    const second: SnapshotEntry = {
      key: "polish",
      kind: "step",
      name: "Polish",
      prompt: "tidy it",
      capability: "edit",
    };
    const h = harness({ runner });
    const twoWrites = { ...task, agent: agentOf([KNOWN.get("implement")!, second, MERGE]) };

    await runTask(h.deps, twoWrites);

    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/Polish left the worktree unclean/);
    expect(h.delivery.merge).not.toHaveBeenCalled();
  });

  // A gate that runs npm ci or the project's suite leaves build output behind; failing the run over
  // an artifact the target repo does not gitignore would be a refusal of nothing
  it("does not judge the tree after a gate, only after a step that could write", async () => {
    let calls = 0;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        // The provenance guard's rev-list/rev-parse are not the "is the tree dirty" check this
        // test is about — an untampered range with no commits made must still pass it.
        if (args.includes("rev-list")) return shell("");
        if (args.includes("rev-parse")) return shell("base1");
        // The pre-staging config scan (BP-403) is not one of the calls this fixture counts
        if (args.includes("--list")) return shell("");
        calls += 1;
        return shell(calls > 2 ? "?? dist/main.js\n" : "");
      }),
    };
    const h = harness({ runner });

    await runTask(h.deps, running("implement", "build", "push", "pull-request"));

    expect(h.reporter.failed).not.toHaveBeenCalled();
    expect(h.delivery.push).toHaveBeenCalled();
  });

  // A pushed branch carrying .github/workflows/*.yml runs in Actions with the repository's secrets,
  // whatever the verdict said
  it("does not push when protected-paths refuses, and says where the work is", async () => {
    const h = harness({
      gateFor: () => rejectingGate("protected-paths", "it edits .github/workflows/ci.yml"),
    });

    await runTask(h.deps, running("implement", "protected-paths"));

    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.reporter.gateRejected.mock.calls[0][2]).toMatch(/on purpose/);
    // No branch, so the comment cannot promise one that is not on the remote
    expect(h.reporter.gateRejected.mock.calls[0][3]).toBe("");
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  // Nothing read the timeout a step or a gate was handed, so folding both onto the gate's cap cut
  // every model step from thirty minutes to ten without a single test noticing
  it("bounds a model step by the project's step timeout, and a gate by the gate cap", async () => {
    const h = harness({ config: { ...config, taskTimeoutMs: 1_800_000 } });

    await runTask(h.deps, running("implement", "build"));

    expect(h.executor.execute.mock.calls[0][0].brief.timeoutMs).toBe(1_800_000);
    expect(h.gateFor.mock.calls[0][2]).toBe(600_000);
  });

  it("gives an entry only what is left of the ceiling when that is less than its cap", async () => {
    let now = 0;
    const h = harness({
      config: { ...config, taskTimeoutMs: 1_800_000, runCeilingMs: 900_000 },
      now: () => now,
      executor: {
        execute: vi.fn<Executor["execute"]>(async () => {
          now = 600_000;
          return { kind: "result", result: completed };
        }),
      },
    });

    await runTask(h.deps, running("implement", "build"));

    expect(h.gateFor.mock.calls[0][2]).toBe(300_000);
  });

  it("requeues when the run's ceiling passes mid-sequence", async () => {
    let now = 0;
    const h = harness({
      config: { ...config, runCeilingMs: 1000 },
      now: () => now,
      executor: {
        execute: vi.fn<Executor["execute"]>(async () => {
          now = 5000;
          return { kind: "result", result: completed };
        }),
      },
    });

    await runTask(h.deps, running("implement", "build"));

    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/ceiling/);
    expect(h.gateFor).not.toHaveBeenCalled();
  });

  // execution.runId lives on the task and every exit clears it, so without this a finished run is
  // one nobody can ask about afterwards
  it("leaves a record on a delivered run, naming the agent that ran", async () => {
    const h = harness();
    await runTask(h.deps, task);

    expect(h.recordRun).toHaveBeenCalledWith(
      "CP",
      expect.objectContaining({ taskKey: "CP-158", agentName: "Default", outcome: "delivered" })
    );
  });

  it("leaves one on every other exit too, naming the block that refused", async () => {
    const h = harness({ gateFor: () => rejectingGate("diff-size", "too big") });
    await runTask(h.deps, running("implement", "diff-size"));

    expect(h.recordRun.mock.calls[0][1]).toMatchObject({
      outcome: "refused",
      refusedBy: "diff-size",
    });
  });

  // Every other exit settles; this one returned bare, so the menubar showed the run parked in
  // "claiming" for ever and no record was written for a task that was claimed and handed back
  it("leaves a record when the board cannot route the outcome", async () => {
    const columnIds = vi
      .fn<PipelineDeps["columnIds"]>()
      .mockResolvedValue(["ready", "doing", "checking"]);
    const h = harness({ columnIds });

    await runTask(h.deps, task);

    expect(h.recordRun).toHaveBeenCalledWith("CP", expect.objectContaining({ taskKey: "CP-158" }));
  });

  // A gate handed the last few seconds fails on the clock and is reported as its own refusal —
  // "blocked the merge at the build gate" for a build that never ran
  it("calls the ceiling rather than starting an entry that cannot finish", async () => {
    let now = 0;
    const h = harness({
      config: { ...config, runCeilingMs: 600_000 },
      now: () => now,
      executor: {
        execute: vi.fn<Executor["execute"]>(async () => {
          now = 599_000;
          return { kind: "result", result: completed };
        }),
      },
    });

    await runTask(h.deps, running("implement", "build"));

    expect(h.gateFor).not.toHaveBeenCalled();
    expect(h.reporter.gateRejected).not.toHaveBeenCalled();
    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/ceiling/);
  });

  // The record is a durable sink and the detail is model-authored prose, the same as a comment
  it("redacts a credential in the detail it records", async () => {
    const credential = `cpw_${"9f3c".repeat(16)}`;
    const executor = {
      execute: vi.fn<Executor["execute"]>().mockResolvedValue({
        kind: "result",
        result: { ...completed, status: "blocked", blockedReason: `no token like ${credential}` },
      }),
    };
    const h = harness({ executor });

    await runTask(h.deps, running("implement"));

    expect(h.recordRun.mock.calls[0][1].detail).not.toContain("cpw_");
  });

  it("counts what the agent's own stream said the run cost", async () => {
    const executor = {
      execute: vi.fn<Executor["execute"]>(async ({ onEvent }) => {
        onEvent?.({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25 });
        return { kind: "result", result: completed };
      }),
    };
    const h = harness({ executor });

    await runTask(h.deps, running("implement"));

    expect(h.recordRun.mock.calls[0][1].costUsd).toBe(0.25);
  });

  // With one step this could not happen — a step that blocks never reaches its commit. With two,
  // the first one's work is committed and only the worktree holds it: nothing is pushed, and the
  // branch ref the parent clone keeps is reset by the next attempt's `git worktree add -B`.
  it("keeps the worktree when a later step blocks after an earlier one committed", async () => {
    let calls = 0;
    const runner = {
      run: vi.fn<Runner["run"]>(async (_command, args) => {
        // The pre-staging config scan (BP-403) is not one of the calls this fixture counts
        if (args.includes("--list")) return shell("");
        calls += 1;
        // rev-parse HEAD is what commitAll hands back as the sha it made — a real commit always
        // resolves it, so a mock that left it empty would prove nothing about state.committed
        // beyond what an unconditional flag already faked.
        if (args.includes("rev-parse")) return shell(IMPLEMENT_COMMIT_SHA);
        // 1: the commit's status, dirty so a commit happens; the rest clean
        return calls === 1 ? shell(" M src/a.ts\n") : shell("");
      }),
    };
    const second: SnapshotEntry = {
      key: "polish",
      kind: "step",
      name: "Polish",
      capability: "edit",
    };
    let step = 0;
    const executor = {
      execute: vi.fn<Executor["execute"]>(async () => {
        step += 1;
        return step === 1
          ? { kind: "result", result: completed }
          : {
              kind: "result",
              result: { ...completed, status: "blocked", blockedReason: "unclear" },
            };
      }),
    };
    const h = harness({ runner, executor });

    await runTask(h.deps, { ...task, agent: agentOf([KNOWN.get("implement")!, second]) });

    expect(h.reporter.blocked).toHaveBeenCalled();
    expect(h.workspace.destroy).not.toHaveBeenCalled();
    expect(h.reporter.blocked.mock.calls[0][1]).toMatch(/not pushed/);
  });

  // gh pr merge deliberately runs with no signal, so a stop pressed during it is only observed
  // afterwards. Releasing there puts a task whose change is already on the base branch back in the
  // queue, and the next claim runs the whole agent again over work that has landed.
  it("reports a merged run as merged even when the stop lands during the merge", async () => {
    const controller = new AbortController();
    const delivery = deliverySpy({
      merge: vi.fn<Delivery["merge"]>(async () => {
        controller.abort();
      }),
    });
    const h = harness({
      createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery),
      signal: controller.signal,
    });

    await runTask(h.deps, merging);

    expect(h.reporter.merged).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
  });

  it("requeues and runs no executor when the worktree cannot be created", async () => {
    const workspace = {
      create: vi.fn<Workspace["create"]>().mockRejectedValue(new Error("disk full")),
      destroy: vi.fn<Workspace["destroy"]>().mockResolvedValue(undefined),
      listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
    };
    const h = harness({ workspace });
    await runTask(h.deps, task);

    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/disk full/);
    expect(h.executor.execute).not.toHaveBeenCalled();
  });
});

describe("what the run says it is doing", () => {
  function watched(overrides: Partial<PipelineDeps> = {}) {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((update) => seen.push(update));
    const h = harness({ telemetry, ...overrides });
    const progress = () =>
      seen.filter((update): update is Progress => !isQuota(update) && !isOutcome(update));
    return {
      h,
      seen,
      phases: () => progress().map((update) => update.phase),
      outcomes: () => seen.filter(isOutcome),
    };
  }

  it("names every stage boundary, in order, all the way through a merge", async () => {
    const { h, phases } = watched();

    await runTask(h.deps, running("implement", "build", "review", "push", "pull-request", "merge"));

    expect(phases()).toEqual([
      "claiming",
      "worktree",
      "step:implement",
      "gates:build",
      "gates:review",
      "push",
      "pr",
      "merge",
    ]);
  });

  it("names the task on every phase, so a panel can say what is running", async () => {
    const { h, seen } = watched();

    await runTask(h.deps, merging);

    expect(seen).toContainEqual({ phase: "claiming", taskKey: "CP-158" });
    expect(seen).toContainEqual({ phase: "merge", taskKey: "CP-158" });
  });

  it("emits exactly one merged outcome when the run completes", async () => {
    const { h, outcomes } = watched();

    await runTask(h.deps, merging);

    expect(outcomes()).toEqual([{ outcome: "merged", taskKey: "CP-158" }]);
  });

  it("emits a gateRejected outcome that names the gate", async () => {
    const { h, outcomes } = watched({
      gateFor: () => rejectingGate("test-presence", "no test file was added"),
    });

    await runTask(h.deps, running("implement", "test-presence"));

    expect(outcomes()).toEqual([
      { outcome: "gateRejected", taskKey: "CP-158", detail: "test-presence" },
    ]);
  });

  it("emits a blocked outcome, the one the operator has to act on", async () => {
    const executor = {
      execute: vi.fn<Executor["execute"]>().mockResolvedValue({
        kind: "result",
        result: { ...completed, status: "blocked", blockedReason: "the scope is ambiguous" },
      }),
    };
    const { h, outcomes } = watched({ executor });

    await runTask(h.deps, task);

    expect(outcomes()).toEqual([
      { outcome: "blocked", taskKey: "CP-158", detail: "the scope is ambiguous" },
    ]);
  });

  it("emits a released outcome when the usage limit ends the run", async () => {
    const executor = {
      execute: vi.fn<Executor["execute"]>().mockResolvedValue({ kind: "usage_limit" }),
    };
    const { h, outcomes } = watched({ executor });

    await runTask(h.deps, task);

    expect(outcomes()).toEqual([
      { outcome: "released", taskKey: "CP-158", detail: "usage limit reached" },
    ]);
  });

  // The detail reaches a Notification Center database that outlives the run, so it takes the same
  // route as board-bound text rather than a shorter one.
  it("scrubs a secret out of an outcome detail", async () => {
    const executor = {
      execute: vi.fn<Executor["execute"]>().mockResolvedValue({
        kind: "result",
        result: {
          ...completed,
          status: "blocked",
          blockedReason: "could not auth with cpw_deadbeef0123456789abcdef01234567",
        },
      }),
    };
    const { h, outcomes } = watched({ executor });

    await runTask(h.deps, task);

    // Asserted positively first: an empty outcome list would satisfy the negative on its own
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ outcome: "blocked", taskKey: "CP-158" });
    expect(JSON.stringify(outcomes())).not.toContain("cpw_deadbeef");
  });

  // Asserted only that runTask resolved, with no bus attached to count outcomes on — it could not
  // fail for the property it names. Counting them on a bus that IS attached is the real question.
  it("emits exactly one outcome for a run, never a second after it settles", async () => {
    const { h, outcomes } = watched({ gateFor: () => rejectingGate("build", "it does not build") });

    await runTask(h.deps, running("implement", "build"));

    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ outcome: "gateRejected" });
  });

  it("stops at the gate that rejected, which is the phase a human needs to see", async () => {
    const { h, phases } = watched({
      gateFor: (entry) =>
        entry.key === "test-presence"
          ? rejectingGate("test-presence", "no test file was added")
          : passingGate(entry.key),
    });

    await runTask(h.deps, running("implement", "diff-size", "test-presence", "push"));

    expect(h.reporter.gateRejected).toHaveBeenCalled();
    expect(phases().at(-1)).toBe("gates:test-presence");
  });

  it("says nothing beyond the stage it never got past when the worktree cannot be created", async () => {
    const workspace = {
      create: vi.fn<Workspace["create"]>().mockRejectedValue(new Error("disk full")),
      destroy: vi.fn<Workspace["destroy"]>().mockResolvedValue(undefined),
      listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
    };
    const { h, phases } = watched({ workspace });

    await runTask(h.deps, task);

    expect(phases()).toEqual(["claiming", "worktree"]);
  });

  // The run's only agent-authored input, and the only route it may take: summarise() bounds it into
  // a name and a path. Handing the raw event to a sink instead would put file bodies on the board.
  it("puts the agent's own stream on the bus through the summarising entry point", async () => {
    const execute = vi.fn<Executor["execute"]>(async ({ onEvent }) => {
      onEvent?.({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Edit",
              input: { file_path: "src/a.ts", content: "TOKEN=cpw_deadbeef0123456789abcdef01234567" },
            },
          ],
        },
      } as never);
      return { kind: "result", result: completed };
    });
    const { h, seen } = watched({ executor: { execute } });

    await runTask(h.deps, task);

    expect(seen).toContainEqual({ phase: "agent", tool: { name: "Edit", target: "src/a.ts" } });
    expect(JSON.stringify(seen)).not.toContain("cpw_deadbeef");
  });

  // It used to hand the executor nothing when no bus was attached. Cost is read off the same
  // stream, and a run record with costUsd permanently 0 is worse than a listener nobody watches.
  it("listens to the agent's stream even with no bus attached, because cost is measured there", async () => {
    const h = harness();

    await runTask(h.deps, task);

    expect(h.executor.execute.mock.calls[0][0].onEvent).toBeTypeOf("function");
    expect(h.reporter.delivered).toHaveBeenCalled();
  });
});

// Merging is a property of the composition now: the default agent pushes and opens a pull request,
// and only an agent carrying a Merge step merges. There is no flag to turn on.
describe("whether a run merges", () => {
  it("opens the pull request and stops when the agent carries no merge step", async () => {
    const h = harness();

    await runTask(h.deps, task);

    expect(h.delivery.push).toHaveBeenCalled();
    expect(h.delivery.openPr).toHaveBeenCalled();
    expect(h.delivery.merge).not.toHaveBeenCalled();
  });

  it("reports it as delivered for review, never as merged", async () => {
    const h = harness();

    await runTask(h.deps, task);

    expect(h.reporter.delivered).toHaveBeenCalledWith(task, "https://x/pull/7", "did it");
    expect(h.reporter.merged).not.toHaveBeenCalled();
  });

  it("never reaches the merge phase", async () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((u) => seen.push(u));
    const h = harness({ telemetry });

    await runTask(h.deps, task);

    const phases = seen.filter((u): u is Progress => !isQuota(u) && !isOutcome(u)).map((u) => u.phase);
    expect(phases).toContain("pr");
    expect(phases).not.toContain("merge");
  });

  it("emits a delivered outcome carrying the pull request url", async () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((u) => seen.push(u));
    const h = harness({ telemetry });

    await runTask(h.deps, task);

    expect(seen.filter(isOutcome)).toEqual([
      { outcome: "delivered", taskKey: "CP-158", detail: "https://x/pull/7" },
    ]);
  });

  it("merges when the agent carries the step", async () => {
    const h = harness();

    await runTask(h.deps, merging);

    expect(h.delivery.merge).toHaveBeenCalled();
    expect(h.reporter.merged).toHaveBeenCalled();
    expect(h.reporter.delivered).not.toHaveBeenCalled();
  });
});
