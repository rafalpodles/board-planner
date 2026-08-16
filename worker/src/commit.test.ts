import { describe, it, expect, vi } from "vitest";
import { commitAll } from "./commit.js";

function runnerReturning(...results: { code: number; stdout?: string; stderr?: string }[]) {
  const run = vi.fn();
  for (const result of results) {
    run.mockResolvedValueOnce({ timedOut: false, stdout: "", stderr: "", ...result });
  }
  return { runner: { run } as never, run };
}

const clean = { code: 0, stdout: "" };
const dirty = { code: 0, stdout: " M src/a.ts\n" };

describe("commitAll", () => {
  it("does nothing when the agent left the tree clean", async () => {
    const { runner, run } = runnerReturning(clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stages everything and commits when there is something to commit", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(run.mock.calls[1][1]).toContain("add");
    expect(run.mock.calls[2][1]).toContain("commit");
    expect(run.mock.calls[2][1]).toContain("BP-1: something");
  });

  // The agent can write .git/hooks/pre-commit with the Write tool it needs for the task itself
  it("runs no hook of the agent's, on any call", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean);
    await commitAll(runner, "/wt", "m");
    for (const call of run.mock.calls) {
      expect(call[1]).toContain("core.hooksPath=/dev/null");
    }
    expect(run.mock.calls[2][1]).toContain("--no-verify");
  });

  it("throws when the commit fails, rather than reporting a run that committed nothing", async () => {
    const { runner } = runnerReturning(dirty, clean, { code: 1, stderr: "nope" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/nope/);
  });

  it("throws when git status itself fails, rather than reading silence as a clean tree", async () => {
    const { runner } = runnerReturning({ code: 128, stderr: "not a repository" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/not a repository/);
  });

  // -m takes the next argument, so a subject beginning with a dash would otherwise be read as one
  it("keeps the message out of git's option slot", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean);
    await commitAll(runner, "/wt", "--amend");
    const args = run.mock.calls[2][1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("--amend");
  });
});
