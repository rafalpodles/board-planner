import { describe, it, expect, vi } from "vitest";
import { commitAll } from "./commit.js";

type Result = { code: number; stdout?: string; stderr?: string };

function runnerFor(...results: Result[]) {
  const run = vi.fn();
  for (const result of results) {
    run.mockResolvedValueOnce({ timedOut: false, stdout: "", stderr: "", ...result });
  }
  return { runner: { run } as never, run };
}

// commitAll's first call is the pre-staging config scan (BP-403), so every case that expects to
// reach `status` needs a clean answer for it first. The cases below read as though they start at
// status; only the scan's own tests use runnerFor directly.
function runnerReturning(...results: Result[]) {
  return runnerFor(noPlantedConfig, ...results);
}

const clean = { code: 0, stdout: "" };
const noPlantedConfig = { code: 0, stdout: "core.bare=false\nfilter.lfs.required=true\n" };
const dirty = { code: 0, stdout: " M src/a.ts\n" };

describe("commitAll", () => {
  it("does nothing when the agent left the tree clean", async () => {
    const { runner, run } = runnerReturning(clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stages everything and commits when there is something to commit", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(run.mock.calls[2][1]).toContain("add");
    expect(run.mock.calls[3][1]).toContain("commit");
    expect(run.mock.calls[3][1]).toContain("BP-1: something");
  });

  // The agent can write .git/hooks/pre-commit with the Write tool it needs for the task itself
  it("runs no hook of the agent's, on any call", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "m");
    for (const call of run.mock.calls) {
      expect(call[1]).toContain("core.hooksPath=/dev/null");
    }
    expect(run.mock.calls[3][1]).toContain("--no-verify");
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
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "--amend");
    const args = run.mock.calls[3][1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("--amend");
  });

  it("returns the sha it created", async () => {
    const { runner } = runnerReturning(dirty, clean, clean, { code: 0, stdout: "abc123\n" });
    expect(await commitAll(runner, "/wt", "BP-1: edit")).toBe("abc123");
  });

  it("returns an empty string when there was nothing to commit", async () => {
    const { runner } = runnerReturning(clean);
    expect(await commitAll(runner, "/wt", "BP-1: edit")).toBe("");
  });

  it("throws when rev-parse fails, rather than reporting a run with no sha", async () => {
    const { runner } = runnerReturning(dirty, clean, clean, { code: 1, stderr: "no HEAD" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/no HEAD/);
  });
});

/**
 * BP-403. Between bindRepository's scan and this call the agent can write `.git/config` and
 * `.git/info/attributes`, and git then runs its program while the worker stages the work. The
 * refusal has to happen before anything reads the working tree — commit.planted-filter.integration
 * proves what real git does; these prove the ordering and the message.
 */
describe("commitAll against a planted config", () => {
  for (const leaf of ["clean", "smudge", "process"]) {
    it(`refuses before it reads the tree when filter.z.${leaf} is set`, async () => {
      const { runner, run } = runnerFor({ code: 0, stdout: `filter.z.${leaf}=/tmp/payload.sh\n` });
      await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(
        new RegExp(`refusing to stage.*filter\\.z\\.${leaf}`)
      );
      // The scan and nothing else: no status, no add, so no call that reads a file's content
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][1]).toContain("--list");
    });
  }

  it("refuses when the config cannot be read at all, rather than reading that as clean", async () => {
    const { runner, run } = runnerFor({ code: 128, stderr: "fatal: not a git repository" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/refusing to stage.*unreadable/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets an inert sibling key through, so a Git-LFS checkout still commits", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, { code: 0, stdout: "abc123\n" });
    expect(await commitAll(runner, "/wt", "m")).toBe("abc123");
    expect(run.mock.calls[2][1]).toContain("add");
  });
});
