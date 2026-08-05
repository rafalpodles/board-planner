import { describe, it, expect, vi } from "vitest";
import { buildGates } from "./index.js";
import { WorkerConfig } from "../config.js";
import { Runner } from "../exec.js";
import { GateContext } from "../types.js";

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    apiBaseUrl: "https://app.example.com",
    apiToken: "cp_t",
    projectId: "cp",
    repoPath: "/repo",
    worktreeRoot: "/worktrees",
    baseBranch: "main",
    pollIntervalMs: 30_000,
    taskTimeoutMs: 1_800_000,
    concurrency: 1,
    maxDiffLines: 400,
    maxDiffFiles: 10,
    workerId: "worker-test",
    ...overrides,
  };
}

const context: GateContext = {
  worktreePath: "/wt",
  task: {
    taskId: "1",
    taskKey: "CP-158",
    taskNumber: 158,
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    attempts: 0,
  },
  result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
  diff: {
    changedLines: 6,
    changedFiles: ["src/a.ts", "src/a.test.ts"],
    patch: "diff --git a/src/a.ts b/src/a.ts",
    truncated: false,
  },
};

function spyRunner() {
  const run = vi
    .fn<Runner["run"]>()
    .mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false });
  return { runner: { run }, run };
}

describe("buildGates", () => {
  it("orders the gates cheapest first, with the model last", () => {
    const { runner } = spyRunner();

    expect(buildGates(config(), runner).map((gate) => gate.name)).toEqual([
      "diff-size",
      "protected-paths",
      "test-presence",
      "build",
      "test-run",
      "review",
    ]);
  });

  // Cost ordering alone would put build ahead of protected-paths, and build runs npm on a tree
  // the agent just wrote — executing its content before any gate has read it
  it("reads the diff with every static gate before a single command runs against the worktree", () => {
    const { runner } = spyRunner();
    const names = buildGates(config(), runner).map((gate) => gate.name);

    const firstExecuting = names.indexOf("build");
    for (const staticGate of ["diff-size", "protected-paths", "test-presence"]) {
      expect(names.indexOf(staticGate)).toBeLessThan(firstExecuting);
    }
  });

  it("carries the configured diff caps into the first gate", async () => {
    const { runner } = spyRunner();
    const [diffSize] = buildGates(config({ maxDiffLines: 5, maxDiffFiles: 1 }), runner);

    const result = await diffSize.run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/limit is 5/);
  });

  // The reviewer is the last thing standing between an unattended agent's diff and main. Turning
  // the implementer down for cost — the whole point of a configurable model — must not take the
  // reviewer down with it, silently, through a setting whose name says nothing about review.
  it("leaves the reviewer on its own model when the implementer's is turned down", async () => {
    const { runner, run } = spyRunner();
    const gates = buildGates(config({ model: "haiku" }), runner);

    await gates.find((gate) => gate.name === "review")!.run(context);

    const args = run.mock.calls[0][1];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args).not.toContain("haiku");
  });

  it("carries the configured review model into the reviewer", async () => {
    const { runner, run } = spyRunner();
    const gates = buildGates(config({ model: "haiku", reviewModel: "sonnet" }), runner);

    await gates.find((gate) => gate.name === "review")!.run(context);

    expect(run.mock.calls[0][1][run.mock.calls[0][1].indexOf("--model") + 1]).toBe("sonnet");
  });

  it("keeps the whole gate chain inside the task's own time budget", async () => {
    const { runner, run } = spyRunner();
    const gates = buildGates(config({ taskTimeoutMs: 300_000 }), runner);

    for (const gate of gates) await gate.run(context);

    const budgets = run.mock.calls.map((call) => call[2].timeoutMs);
    expect(budgets[0]).toBe(100_000);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(100_000);
  });

  it("caps a very long task budget rather than scaling with it", async () => {
    const { runner, run } = spyRunner();
    const gates = buildGates(config({ taskTimeoutMs: 36_000_000 }), runner);

    for (const gate of gates) await gate.run(context);

    expect(Math.max(...run.mock.calls.map((call) => call[2].timeoutMs))).toBe(600_000);
  });
});

// The one difference between the "write code" and "write and review" presets. Everything else —
// the static gates, the build, the tests, the push and the pull request — is identical.
describe("the review gate is the thing a preset turns off", () => {
  const runner = { run: vi.fn() } as unknown as Runner;
  const names = (overrides: Partial<WorkerConfig>) =>
    buildGates(config(overrides), runner).map((g) => g.name);

  it("drops only the reviewer when it is switched off", () => {
    const withReview = names({ reviewGate: true });
    const without = names({ reviewGate: false });

    expect(withReview).toContain("review");
    expect(without).not.toContain("review");
    expect(without).toEqual(withReview.filter((n) => n !== "review"));
  });

  // Failing safe: an older caller, or a partial config, must still review. Only an explicit
  // opt-out removes the second model — this is the property that keeps "nothing merges
  // unreviewed" true when something upstream forgets the field.
  it("still reviews when the config never mentions the field", () => {
    expect(names({})).toContain("review");
  });
});
