import { describe, it, expect, vi } from "vitest";
import { buildGate } from "./build.js";
import { CommandResult, Runner } from "../exec.js";
import { GateContext } from "../types.js";

const TIMEOUT_MS = 5000;

const context: GateContext = {
  worktreePath: "/wt",
  task: {
    taskId: "1",
    taskKey: "CP-1",
    taskNumber: 1,
    title: "t",
    description: "d",
    acceptanceCriteria: [],
    attempts: 0,
  },
  result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
  diff: { changedLines: 10, changedFiles: ["src/a.ts"], patch: "", truncated: false },
};

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };

function runner(...results: CommandResult[]) {
  const run = vi.fn<Runner["run"]>();
  for (const result of results) run.mockResolvedValueOnce(result);
  run.mockResolvedValue(ok);
  return { runner: { run }, run };
}

describe("buildGate", () => {
  it("installs dependencies before building a fresh worktree", async () => {
    const { runner: r, run } = runner(ok, ok);

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1][0]).toBe("ci");
    expect(run.mock.calls[0][2].cwd).toBe("/wt");
    expect(run.mock.calls[1][1]).toEqual(["run", "build"]);
    expect(run.mock.calls[1][2].cwd).toBe("/wt");
  });

  it("rejects and carries the tail of the output", async () => {
    const { runner: r } = runner(ok, { ...ok, code: 1, stderr: "Type error on line 4" });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Type error on line 4/);
  });

  it("names the exit code when the build fails without printing anything", async () => {
    const { runner: r } = runner(ok, { ...ok, code: 127 });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/127/);
  });

  it("keeps stdout when stderr carries only warnings", async () => {
    const { runner: r } = runner(ok, {
      ...ok,
      code: 1,
      stdout: "Failed to compile.\n./src/a.ts:5:10\nType error: no such property",
      stderr: "(node:1) DeprecationWarning: punycode",
    });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Type error: no such property/);
  });

  it("rejects on timeout", async () => {
    const { runner: r } = runner(ok, { code: -1, stdout: "", stderr: "", timedOut: true });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });

  it("names a failed dependency install and does not run the build", async () => {
    const { runner: r, run } = runner({
      ...ok,
      code: 1,
      stderr: "npm error code ENOTFOUND",
    });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/install/i);
    expect(result.reason).toMatch(/ENOTFOUND/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects when the dependency install times out", async () => {
    const { runner: r } = runner({ code: -1, stdout: "", stderr: "", timedOut: true });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/install .*timed out/i);
  });

  it("truncates a long failure to the tail and says so", async () => {
    const stdout = `${"noise\n".repeat(2000)}Type error: the last line matters`;
    const { runner: r } = runner(ok, { ...ok, code: 1, stdout });

    const result = await buildGate(r, TIMEOUT_MS).run(context);

    expect(result.reason).toMatch(/Type error: the last line matters/);
    expect(result.reason).toMatch(/truncated/i);
    expect(result.reason.length).toBeLessThan(2200);
  });

  it("gives the build only the time the install left", async () => {
    const { runner: r, run } = runner(ok, ok);

    await buildGate(r, TIMEOUT_MS).run(context);

    expect(run.mock.calls[1][2].timeoutMs).toBeLessThanOrEqual(TIMEOUT_MS);
    expect(run.mock.calls[1][2].timeoutMs).toBeGreaterThan(0);
  });
});
