import { describe, it, expect, vi } from "vitest";
import { runStep, StepContext } from "./steps.js";
import { ExecutionResult, SnapshotEntry } from "./types.js";

const base = { key: "implement", kind: "step" as const, name: "Implement" };

const completed: ExecutionResult = {
  status: "completed",
  summary: "did it",
  filesChanged: [],
  testsAdded: [],
  blockedReason: "",
};

function ctx(over: Partial<StepContext> = {}) {
  const context = {
    worktreePath: "/wt",
    branch: "cp-1/x",
    task: { taskKey: "CP-1", title: "t", description: "", acceptanceCriteria: [] },
    executor: { execute: vi.fn(async () => ({ kind: "result", result: completed })) },
    delivery: {
      push: vi.fn(async () => {}),
      openPr: vi.fn(async () => "https://x/pull/7"),
      merge: vi.fn(async () => {}),
    },
    commit: vi.fn(async () => "sha1"),
    state: { committed: false, commits: [], pushed: false, prUrl: "", merged: false, summary: "", lastResult: completed },
    timeoutMs: 1000,
    onEvent: vi.fn(),
    ...over,
  } as unknown as StepContext;
  return context as StepContext & {
    executor: { execute: ReturnType<typeof vi.fn> };
    delivery: { push: ReturnType<typeof vi.fn>; openPr: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn> };
    commit: ReturnType<typeof vi.fn>;
  };
}

function entry(over: Partial<SnapshotEntry>): SnapshotEntry {
  return { ...base, ...over };
}

describe("runStep — a model step", () => {
  it("runs it and commits what it wrote", async () => {
    const c = ctx();
    const outcome = await runStep(entry({ capability: "edit", prompt: "do it" }), c);

    expect(outcome).toEqual({ kind: "ok" });
    expect(c.commit).toHaveBeenCalled();
  });

  it("does not commit after a read-only step, which cannot have written anything", async () => {
    const c = ctx();
    await runStep(entry({ key: "analyse", capability: "read-only" }), c);

    expect(c.commit).not.toHaveBeenCalled();
  });

  it("gives the model the block's prompt, model and capability", async () => {
    const c = ctx();
    await runStep(
      entry({ capability: "edit", prompt: "do it", model: "sonnet", fallbackModel: "haiku" }),
      c
    );

    expect(c.executor.execute.mock.calls[0][0].brief).toMatchObject({
      prompt: "do it",
      capability: "edit",
      model: "sonnet",
      fallbackModel: "haiku",
      timeoutMs: 1000,
    });
  });

  // Telemetry is how the board shows a run is alive and the only place cost is measured; a step
  // that drops it makes a forty-minute agent look like a hung one
  it("forwards the event stream, so tool use still reaches the board", async () => {
    const c = ctx();
    await runStep(entry({ capability: "edit" }), c);

    expect(c.executor.execute.mock.calls[0][0].onEvent).toBeTypeOf("function");
  });

  it("carries a blocked result out rather than treating it as success", async () => {
    const c = ctx({
      executor: {
        execute: vi.fn(async () => ({
          kind: "result",
          result: { ...completed, status: "blocked", blockedReason: "unclear" },
        })),
      } as never,
    });

    expect(await runStep(entry({ capability: "edit" }), c)).toEqual({
      kind: "blocked",
      reason: "unclear",
    });
  });

  it("passes a usage limit and a timeout straight through", async () => {
    for (const kind of ["usage_limit", "timeout"] as const) {
      const c = ctx({ executor: { execute: vi.fn(async () => ({ kind })) } as never });
      expect(await runStep(entry({ capability: "edit" }), c)).toEqual({ kind });
    }
  });

  // The comment on that try/catch says letting it throw would destroy the only copy of the work,
  // and nothing exercised it: the commit spy in this file could not reject
  it("turns a failed commit into the step's own error rather than letting it throw", async () => {
    const c = ctx({
      commit: vi.fn(async () => {
        throw new Error("git commit failed: pre-commit hook");
      }),
    });

    const outcome = await runStep(entry({ capability: "edit" }), c);

    expect(outcome).toEqual({ kind: "error", message: expect.stringContaining("pre-commit hook") });
    expect(c.state.committed).toBe(false);
  });

  it("records that it committed, so an exit after it keeps the worktree", async () => {
    const c = ctx();

    await runStep(entry({ capability: "edit" }), c);

    expect(c.state.committed).toBe(true);
  });

  it("records every sha it commits, oldest first", async () => {
    const c = ctx({ commit: vi.fn(async () => "sha1") });

    await runStep(entry({ capability: "edit" }), c);

    expect(c.state.commits).toEqual(["sha1"]);
  });

  it("records nothing when the step committed nothing", async () => {
    const c = ctx({ commit: vi.fn(async () => "") });

    await runStep(entry({ capability: "edit" }), c);

    expect(c.state.commits).toEqual([]);
  });

  // The gate context takes one result and a composed agent produces several
  it("remembers the most recent result and summary for the gates that follow", async () => {
    const c = ctx();
    await runStep(entry({ capability: "edit" }), c);

    expect(c.state.summary).toBe("did it");
    expect(c.state.lastResult).toEqual(completed);
  });
});

describe("runStep — a worker action", () => {
  it("pushes on the push step and calls no model", async () => {
    const c = ctx({ state: { committed: true, commits: ["sha1"], pushed: false, prUrl: "", merged: false, summary: "", lastResult: completed } });
    await runStep(entry({ key: "push", deterministic: true }), c);

    expect(c.delivery.push).toHaveBeenCalledWith("/wt", "cp-1/x", "sha1");
    expect(c.executor.execute).not.toHaveBeenCalled();
  });

  it("refuses nothing itself when no commit was recorded, leaving delivery to say so", async () => {
    const c = ctx();
    await runStep(entry({ key: "push", deterministic: true }), c);

    expect(c.delivery.push).toHaveBeenCalledWith("/wt", "cp-1/x", "");
  });

  // RunState.commits is documented "oldest first", and the push step reads its *last* element —
  // so that ordering is load-bearing, not incidental
  it("pushes the newest of several commits, not the first", async () => {
    const c = ctx({ commit: vi.fn().mockResolvedValueOnce("sha1").mockResolvedValueOnce("sha2") });

    await runStep(entry({ capability: "edit" }), c);
    await runStep(entry({ capability: "edit" }), c);
    expect(c.state.commits).toEqual(["sha1", "sha2"]);

    await runStep(entry({ key: "push", deterministic: true }), c);

    expect(c.delivery.push).toHaveBeenCalledWith("/wt", "cp-1/x", "sha2");
  });

  it("remembers the pull request url, and that a merge happened", async () => {
    const c = ctx();
    await runStep(entry({ key: "pull-request", deterministic: true }), c);
    await runStep(entry({ key: "merge", deterministic: true }), c);

    expect(c.state.prUrl).toBe("https://x/pull/7");
    expect(c.state.merged).toBe(true);
  });

  // The composition rules refuse this shape on save, but a snapshot may predate them
  it("refuses a merge step with no pull request to merge", async () => {
    const c = ctx();
    const outcome = await runStep(entry({ key: "merge", deterministic: true }), c);

    expect(outcome.kind).toBe("error");
    expect(c.delivery.merge).not.toHaveBeenCalled();
  });

  it("names a worker action it does not implement", async () => {
    const outcome = await runStep(entry({ key: "deploy", deterministic: true }), ctx());

    expect(outcome).toEqual({ kind: "error", message: expect.stringContaining("deploy") });
  });
});
