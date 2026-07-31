import { describe, it, expect, vi } from "vitest";
import { testRunGate } from "./test-run.js";
import { CommandResult, Runner } from "../exec.js";
import { GateContext } from "../types.js";

const TIMEOUT_MS = 5000;

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
  diff: { changedLines: 10, changedFiles: ["src/a.ts"], patch: "", truncated: false },
};

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };

function runnerReturning(result: CommandResult) {
  const run = vi.fn<Runner["run"]>().mockResolvedValue(result);
  return { runner: { run }, run };
}

describe("testRunGate", () => {
  it("accepts a passing suite", async () => {
    const { runner } = runnerReturning(ok);

    expect((await testRunGate(runner, TIMEOUT_MS).run(context)).ok).toBe(true);
  });

  it("rejects a failing suite and carries the output", async () => {
    const { runner } = runnerReturning({
      ...ok,
      code: 1,
      stdout: "FAIL src/a.test.ts > adds two numbers",
    });

    const result = await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/adds two numbers/);
  });

  it("keeps stderr as well, wherever the runner wrote the failure", async () => {
    const { runner } = runnerReturning({
      ...ok,
      code: 1,
      stderr: "Error: Cannot find module './missing.js'",
    });

    const result = await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(result.reason).toMatch(/Cannot find module/);
  });

  it("names the exit code when the suite fails without printing anything", async () => {
    const { runner } = runnerReturning({ ...ok, code: 127 });

    const result = await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/127/);
  });

  it("rejects on timeout naming the budget", async () => {
    const { runner } = runnerReturning({ code: -1, stdout: "", stderr: "", timedOut: true });

    const result = await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out after 5000ms/);
  });

  it("truncates a long failure to the tail and says so", async () => {
    const stdout = `${"noise\n".repeat(2000)}FAIL src/a.test.ts > the last line matters`;
    const { runner } = runnerReturning({ ...ok, code: 1, stdout });

    const result = await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(result.reason).toMatch(/the last line matters/);
    expect(result.reason).toMatch(/truncated/i);
    expect(result.reason.length).toBeLessThan(2200);
  });

  it("runs the suite in the worktree", async () => {
    const { runner, run } = runnerReturning(ok);

    await testRunGate(runner, TIMEOUT_MS).run(context);

    expect(run).toHaveBeenCalledWith("npm", ["test"], expect.objectContaining({ cwd: "/wt" }));
    expect(run.mock.calls[0][2].timeoutMs).toBe(TIMEOUT_MS);
  });
});
