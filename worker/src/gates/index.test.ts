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
      "test-presence",
      "build",
      "test-run",
      "review",
    ]);
  });

  it("carries the configured diff caps into the first gate", async () => {
    const { runner } = spyRunner();
    const [diffSize] = buildGates(config({ maxDiffLines: 5, maxDiffFiles: 1 }), runner);

    const result = await diffSize.run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/limit is 5/);
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
