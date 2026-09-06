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

function callWith(run: ReturnType<typeof vi.fn>, subcommand: string): string[] {
  const call = run.mock.calls.find(([, args]) => (args as string[]).includes(subcommand));
  if (!call) throw new Error(`git ${subcommand} was never run`);
  return call[1] as string[];
}

function runnerReturning(...results: Result[]) {
  return runnerFor(readableConfig, noPlantedConfig, ...results);
}

const clean = { code: 0, stdout: "" };
const local = (...lines: string[]) => lines.map((line) => `local\t${line}`).join("\n") + "\n";
const readableConfig = { code: 0, stdout: "core.bare=false\n" };
const noPlantedConfig = { code: 0, stdout: local("core.bare=false", "filter.lfs.required=true") };
const dirty = { code: 0, stdout: " M src/a.ts\n" };

describe("commitAll", () => {
  it("does nothing when the agent left the tree clean", async () => {
    const { runner, run } = runnerReturning(clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stages everything and commits when there is something to commit", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "BP-1: something");
    expect(callWith(run, "add")).toContain("add");
    expect(callWith(run, "commit")).toContain("BP-1: something");
  });

  it("runs no hook of the agent's, on any call", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "m");
    for (const call of run.mock.calls) {
      expect(call[1]).toContain("core.hooksPath=/dev/null");
    }
    expect(callWith(run, "commit")).toContain("--no-verify");
  });

  it("throws when the commit fails, rather than reporting a run that committed nothing", async () => {
    const { runner } = runnerReturning(dirty, clean, { code: 1, stderr: "nope" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/nope/);
  });

  it("throws when git status itself fails, rather than reading silence as a clean tree", async () => {
    const { runner } = runnerReturning({ code: 128, stderr: "not a repository" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/not a repository/);
  });

  it("keeps the message out of git's option slot", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, "/wt", "--amend");
    const args = callWith(run, "commit");
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

describe("commitAll against a planted config", () => {
  for (const leaf of ["clean", "smudge", "process"]) {
    it(`refuses before it reads the tree when filter.z.${leaf} is set`, async () => {
      const { runner, run } = runnerFor(readableConfig, { code: 0, stdout: local(`filter.z.${leaf}=/tmp/payload.sh`) });
      await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(
        new RegExp(`refusing to stage.*filter\\.z\\.${leaf}`)
      );
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][1]).toContain("--show-scope");
    });
  }

  it("refuses when the config cannot be read at all, rather than reading that as clean", async () => {
    const { runner, run } = runnerFor({ code: 128, stderr: "fatal: not a git repository" });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/refusing to stage.*unreadable/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets an inert sibling leaf through", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, { code: 0, stdout: "abc123\n" });
    expect(await commitAll(runner, "/wt", "m")).toBe("abc123");
    expect(callWith(run, "add")).toContain("add");
  });

  it("refuses filter.lfs.clean like any other, which is what bindRepository already did", async () => {
    const { runner } = runnerFor(readableConfig, { code: 0, stdout: local("filter.lfs.clean=git-lfs clean -- %f") });
    await expect(commitAll(runner, "/wt", "m")).rejects.toThrow(/refusing to stage.*filter\.lfs\.clean/);
  });
});
