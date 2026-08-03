import { describe, it, expect, vi } from "vitest";
import { ApiClient, StatusIds } from "./api.js";
import { SHUTDOWN_SIGNAL } from "./commands.js";
import { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { CommandResult, Runner } from "./exec.js";
import { Executor } from "./executor.js";
import { Reporter } from "./reporter.js";
import { createTelemetry, isOutcome, isQuota, Progress, TelemetryUpdate } from "./telemetry.js";
import { Workspace } from "./workspace.js";
import { ClaimedTask, DiffStats, ExecutionResult, Gate } from "./types.js";
import { PipelineDeps, resolveStatusIds, runTask } from "./pipeline.js";

const task: ClaimedTask = {
  taskId: "t1",
  projectId: "CP",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "body",
  acceptanceCriteria: [],
  attempts: 1,
};

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

const diff: DiffStats = { changedLines: 10, changedFiles: ["a.ts"], patch: "d", truncated: false };

const config: WorkerConfig = {
  apiBaseUrl: "http://localhost:3000",
  apiToken: "token",
  repoPath: "/repo",
  worktreeRoot: "/worktrees",
  stateDir: "/state",
  baseBranch: "main",
  pollIntervalMs: 1000,
  taskTimeoutMs: 900_000,
  maxDiffLines: 400,
  maxDiffFiles: 10,
  workerId: "worker-test",
};

function shell(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", timedOut: false, ...overrides };
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
  };
  const columnIds = vi.fn<PipelineDeps["columnIds"]>().mockResolvedValue(board);
  const reporter = {
    blocked: vi.fn<Reporter["blocked"]>().mockResolvedValue(undefined),
    gateRejected: vi.fn<Reporter["gateRejected"]>().mockResolvedValue(undefined),
    released: vi.fn<Reporter["released"]>().mockResolvedValue(undefined),
    requeued: vi.fn<Reporter["requeued"]>().mockResolvedValue(undefined),
    merged: vi.fn<Reporter["merged"]>().mockResolvedValue(undefined),
    failed: vi.fn<Reporter["failed"]>().mockResolvedValue(undefined),
  };
  const createReporter = vi.fn<PipelineDeps["createReporter"]>(() => reporter);
  const delivery = deliverySpy();
  const createDelivery = vi.fn<PipelineDeps["createDelivery"]>(() => delivery);
  const workspace = {
    create: vi.fn<Workspace["create"]>().mockResolvedValue("/wt"),
    destroy: vi.fn<Workspace["destroy"]>().mockResolvedValue(undefined),
    listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
  };
  const executor = {
    execute: vi
      .fn<Executor["execute"]>()
      .mockResolvedValue({ kind: "result", result: completed }),
  };
  const collectDiff = vi.fn<PipelineDeps["collectDiff"]>().mockResolvedValue(diff);
  const runner = { run: vi.fn<Runner["run"]>().mockResolvedValue(shell()) };

  const deps: PipelineDeps = {
    config,
    api,
    columnIds,
    createReporter,
    createDelivery,
    workspace,
    executor,
    collectDiff,
    runner,
    gates: [],
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
    runner,
  };
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
  it("merges and reports done on the happy path", async () => {
    const h = harness();
    await runTask(h.deps, task);

    expect(h.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker");
    expect(h.delivery.openPr).toHaveBeenCalledWith("/wt", task, "did it");
    expect(h.delivery.merge).toHaveBeenCalledWith("/wt", "https://x/pull/7");
    expect(h.reporter.merged).toHaveBeenCalledWith(task, "https://x/pull/7", "did it");
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("opens the pull request against the configured base branch", async () => {
    const h = harness({ config: { ...config, baseBranch: "develop" } });
    await runTask(h.deps, task);

    expect(h.createDelivery).toHaveBeenCalledWith(h.runner, "develop");
  });

  it("diffs against the configured base branch", async () => {
    const h = harness({ config: { ...config, baseBranch: "develop" } });
    await runTask(h.deps, task);

    expect(h.collectDiff).toHaveBeenCalledWith(h.runner, "/wt", "develop");
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

    expect(h.reporter.requeued).toHaveBeenCalledWith(task, "could not parse claude output");
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
    const h = harness({ runner, gates: [gate] });
    await runTask(h.deps, task);

    expect(runner.run).toHaveBeenCalledWith(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "status", "--porcelain"],
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

  it("treats a worktree whose state cannot be read as dirty", async () => {
    const runner = {
      run: vi
        .fn<Runner["run"]>()
        .mockResolvedValue(shell("", { code: 128, stderr: "not a git repository" })),
    };
    const h = harness({ runner, gates: [passingGate("diff-size")] });
    await runTask(h.deps, task);

    expect(h.collectDiff).not.toHaveBeenCalled();
    expect(h.reporter.failed.mock.calls[0][1]).toMatch(/not a git repository/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("runs the gates on a clean worktree", async () => {
    const gate = passingGate("diff-size");
    const h = harness({ gates: [gate] });
    await runTask(h.deps, task);

    expect(gate.run).toHaveBeenCalledWith({
      worktreePath: "/wt",
      task,
      result: completed,
      diff,
    });
    expect(h.reporter.merged).toHaveBeenCalled();
  });

  it("stops at the first failing gate and names it", async () => {
    const failing = rejectingGate("diff-size", "too big");
    const later = passingGate("review");
    const h = harness({ gates: [failing, later] });
    await runTask(h.deps, task);

    expect(h.reporter.gateRejected).toHaveBeenCalledWith(
      task,
      "diff-size",
      "too big",
      "cp-158/worker"
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
    const h = harness({ gates: [first, later], signal: controller.signal });

    await runTask(h.deps, task);

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
    const h = harness({ gates: [gate], signal: controller.signal });

    await runTask(h.deps, task);

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

    await runTask(h.deps, task);

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

    await runTask(h.deps, task);

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

    // The trailing undefined is the stream listener: this harness attaches no telemetry bus
    expect(execute).toHaveBeenCalledWith(task, "/wt", controller.signal, undefined);
  });

  it("gives every gate the signal, so a build or review gate can honour a stop", async () => {
    const controller = new AbortController();
    const gate = passingGate("build");
    const h = harness({ gates: [gate], signal: controller.signal });

    await runTask(h.deps, task);

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
    const h = harness({ gates: [gate], signal: controller.signal });

    await runTask(h.deps, task);

    expect(h.delivery.push).not.toHaveBeenCalled();
    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.merged).not.toHaveBeenCalled();
    expect(h.reporter.requeued).not.toHaveBeenCalled();
  });

  it("pushes the rejected branch before discarding the worktree", async () => {
    const h = harness({ gates: [rejectingGate("diff-size", "too big")] });
    await runTask(h.deps, task);

    expect(h.delivery.push).toHaveBeenCalledWith("/wt", "cp-158/worker");
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("says so in the comment and keeps the worktree when the rejected branch will not push", async () => {
    const delivery = deliverySpy({
      push: vi.fn<Delivery["push"]>().mockRejectedValue(new Error("stale info")),
    });
    const h = harness({
      createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery),
      gates: [rejectingGate("diff-size", "too big")],
    });
    await runTask(h.deps, task);

    const reason = h.reporter.gateRejected.mock.calls[0][2];
    expect(reason).toMatch(/too big/);
    expect(reason).toMatch(/stale info/);
    expect(reason).toMatch(/not on the remote/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("returns the task to the queue when a gate could not run because of a usage limit", async () => {
    const gate = rejectingGate(
      "review",
      "the review could not be completed: claude exited 1\nClaude AI usage limit reached|1754006400"
    );
    const h = harness({ gates: [gate] });
    await runTask(h.deps, task);

    expect(h.reporter.released).toHaveBeenCalled();
    expect(h.reporter.gateRejected).not.toHaveBeenCalled();
    expect(h.delivery.push).not.toHaveBeenCalled();
  });

  it("still rejects a verdict that merely talks about a usage limit", async () => {
    const gate = rejectingGate(
      "review",
      "the reviewer rejected the change: it deletes the usage limit reached branch"
    );
    const h = harness({ gates: [gate] });
    await runTask(h.deps, task);

    expect(h.reporter.gateRejected).toHaveBeenCalled();
    expect(h.reporter.released).not.toHaveBeenCalled();
  });

  it("destroys the worktree and requeues when a gate throws", async () => {
    const exploding = { name: "build", run: vi.fn<Gate["run"]>().mockRejectedValue(new Error("boom")) };
    const h = harness({ gates: [exploding] });
    await runTask(h.deps, task);

    expect(h.reporter.requeued.mock.calls[0][1]).toMatch(/boom/);
    expect(h.workspace.destroy).toHaveBeenCalledWith("CP-158");
  });

  it("keeps the worktree and names the branch and the pr when the merge fails", async () => {
    const delivery = deliverySpy({
      merge: vi.fn<Delivery["merge"]>().mockRejectedValue(new Error("not mergeable")),
    });
    const h = harness({ createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery) });
    await runTask(h.deps, task);

    const reason = h.reporter.failed.mock.calls[0][1];
    expect(reason).toMatch(/not mergeable/);
    expect(reason).toMatch(/cp-158\/worker/);
    expect(reason).toMatch(/https:\/\/x\/pull\/7/);
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("names only the branch when the delivery push fails before any pr exists", async () => {
    const delivery = deliverySpy({
      push: vi.fn<Delivery["push"]>().mockRejectedValue(new Error("permission denied")),
    });
    const h = harness({ createDelivery: vi.fn<PipelineDeps["createDelivery"]>(() => delivery) });
    await runTask(h.deps, task);

    const reason = h.reporter.failed.mock.calls[0][1];
    expect(reason).toMatch(/permission denied/);
    expect(reason).toMatch(/cp-158\/worker/);
    expect(reason).not.toMatch(/pull/);
    expect(delivery.openPr).not.toHaveBeenCalled();
    expect(h.workspace.destroy).not.toHaveBeenCalled();
  });

  it("never rejects, even when the cleanup itself throws", async () => {
    const workspace = {
      create: vi.fn<Workspace["create"]>().mockResolvedValue("/wt"),
      destroy: vi.fn<Workspace["destroy"]>(() => {
        throw new Error("worktree is locked");
      }),
      listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue([]),
    };
    const h = harness({ workspace });

    await expect(runTask(h.deps, task)).resolves.toBeUndefined();
    expect(h.reporter.merged).toHaveBeenCalled();
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
    const { h, phases } = watched({ gates: [passingGate("build"), passingGate("review")] });

    await runTask(h.deps, task);

    expect(phases()).toEqual([
      "claiming",
      "worktree",
      "agent",
      "gates:build",
      "gates:review",
      "push",
      "pr",
      "merge",
    ]);
  });

  it("names the task on every phase, so a panel can say what is running", async () => {
    const { h, seen } = watched();

    await runTask(h.deps, task);

    expect(seen).toContainEqual({ phase: "claiming", taskKey: "CP-158" });
    expect(seen).toContainEqual({ phase: "merge", taskKey: "CP-158" });
  });

  it("emits exactly one merged outcome when the run completes", async () => {
    const { h, outcomes } = watched({ gates: [passingGate("build")] });

    await runTask(h.deps, task);

    expect(outcomes()).toEqual([{ outcome: "merged", taskKey: "CP-158" }]);
  });

  it("emits a gateRejected outcome that names the gate", async () => {
    const { h, outcomes } = watched({
      gates: [rejectingGate("test-presence", "no test file was added")],
    });

    await runTask(h.deps, task);

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

  it("emits no outcome at all when no bus is attached", async () => {
    const h = harness();

    await expect(runTask(h.deps, task)).resolves.toBeUndefined();
  });

  it("stops at the gate that rejected, which is the phase a human needs to see", async () => {
    const { h, phases } = watched({
      gates: [passingGate("diff-size"), rejectingGate("test-presence", "no test file was added")],
    });

    await runTask(h.deps, task);

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
    const execute = vi.fn<Executor["execute"]>(async (_task, _worktree, _signal, onEvent) => {
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

  it("hands the executor no listener at all when no bus is attached", async () => {
    const h = harness();

    await runTask(h.deps, task);

    expect(h.executor.execute.mock.calls[0][3]).toBeUndefined();
    expect(h.reporter.merged).toHaveBeenCalled();
  });
});
