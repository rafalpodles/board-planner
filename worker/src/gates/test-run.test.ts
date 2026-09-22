import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRunGate } from "./test-run.js";
import { CommandResult, Runner } from "../exec.js";
import { GateContext } from "../types.js";
import { claimedTask } from "../__fixtures__/task.js";
import { SANDBOX_COMMAND, UNCONFINED_REASON } from "../sandbox.js";

const TIMEOUT_MS = 5000;

// A real directory, because the gate confines itself to it since BP-608 and seatbelt matches the
// resolved path — a name that does not exist cannot be resolved, and reads as a machine that
// cannot confine anything.
let worktree = "";

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "bp608-test-run-"));
  context.worktreePath = worktree;
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

const context: GateContext = {
  worktreePath: "/wt",
  task: claimedTask({ title: "t", description: "d" }),
  result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
  diff: { changedLines: 10, changedFiles: ["src/a.ts"], patch: "", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" , symlinks: [], suppressedDiffs: [], gitlinks: []},
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

  it("names the command it ran, for the pull request (BP-780)", async () => {
    const { runner } = runnerReturning(ok);

    expect((await testRunGate(runner, TIMEOUT_MS).run(context)).commands).toEqual(["npm test"]);
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

    const [command, args, opts] = run.mock.calls[0];
    expect(command).toBe(SANDBOX_COMMAND);
    expect(args.slice(-2)).toEqual(["npm", "test"]);
    expect(opts.cwd).toBe(worktree);
    expect(opts.timeoutMs).toBe(TIMEOUT_MS);
  });

  /**
   * BP-608. The agent's own tools are confined, so an Implement step writes its escape as a *test*
   * — inside the worktree, which the sandbox permits, and exactly what the Test-presence gate asks
   * for — and this is the command that executes it as the worker's uid.
   */
  it("confines the suite to the worktree and a temp directory, and to nothing else", async () => {
    const { runner, run } = runnerReturning(ok);

    await testRunGate(runner, TIMEOUT_MS).run(context);

    const args = run.mock.calls[0][1];
    const writable = args.filter((_, index) => args[index - 1] === "-D");
    expect(writable).toEqual([
      `W0=${realpathSync(worktree)}`,
      // This run's own scratch directory, inside the machine's temp tree and gone when the
      // command ends — not the whole of `/var/folders`, which every process of this user writes to
      expect.stringMatching(/^W1=.*cp-gate-/),
    ]);
  });

  // The npm cache is the install's, and only the install's: this is the command that runs the
  // agent's code, and a cache it can write is one a later run installs from.
  it("is not given the npm cache", async () => {
    const { runner, run } = runnerReturning(ok);

    await testRunGate(runner, TIMEOUT_MS).run(context);

    const args = run.mock.calls[0][1];
    expect(args.filter((_, index) => args[index - 1] === "-D")).toHaveLength(2);
    expect(run.mock.calls[0][2].env?.npm_config_cache).toBeTruthy();
  });

  // A machine that cannot confine refuses the gate rather than running the suite unconfined —
  // the same call the implementer step and the review gate make, for the same reason.
  it("refuses rather than running the suite unconfined", async () => {
    const { runner, run } = runnerReturning(ok);
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      const result = await testRunGate(runner, TIMEOUT_MS).run(context);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain(UNCONFINED_REASON);
      // A machine fault, not a rejection: this machine has judged nothing, so blaming the change
      // would spend the attempt and push the branch — the same call `gates/review.ts` makes.
      expect(result.machineFault).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });

  it("passes the signal through to the runner, so a stop can kill the suite", async () => {
    const controller = new AbortController();
    const { runner, run } = runnerReturning(ok);

    await testRunGate(runner, TIMEOUT_MS).run({ ...context, signal: controller.signal });

    expect(run.mock.calls[0][2].signal).toBe(controller.signal);
  });
});
