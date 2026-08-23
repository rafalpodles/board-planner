import { describe, it, expect, vi } from "vitest";
import { createWorkspace, reapOrphans, Workspace } from "./workspace.js";
import { CommandResult, RunOpts } from "./exec.js";
import { gitArgs } from "./git-safety.js";

const config = {
  repoPath: "/repo",
  worktreeRoot: "/worktrees",
  baseBranch: "main",
} as never;

function runnerReturning(stdout = "") {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false });
  return { runner: { run }, run };
}

// Every call carries the hardening flags gitArgs prepends — stripped here so the response maps
// below keep naming the real git subcommand. What those flags ARE is git-safety.test.ts's subject;
// taking them from the same source is what stops this file breaking every time one is added.
const HARDENING_PREFIX = gitArgs([]);

function fakeGit(responses: Record<string, Partial<CommandResult>>) {
  const run = vi.fn(async (_command: string, args: string[], _opts: RunOpts): Promise<CommandResult> => {
    const override = responses[args.slice(HARDENING_PREFIX.length).join(" ")];
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...override };
  });
  return { runner: { run }, run };
}

describe("createWorkspace", () => {
  it("creates a worktree on a task-keyed branch", async () => {
    const { runner, run } = runnerReturning("base1\n");
    const result = await createWorkspace(config, runner).create("CP-158", "worker");

    expect(result.path).toBe("/worktrees/CP-158");
    expect(result.baseSha).toBe("base1");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "cp-158/worker", "/worktrees/CP-158", "base1"],
      expect.objectContaining({ cwd: "/repo", env: expect.objectContaining({ GIT_CONFIG_NOSYSTEM: "1" }) }),
    );
    expect(run).not.toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("creates the worktree at a sha resolved before the agent could run", async () => {
    const { runner, run } = fakeGit({
      "rev-parse --verify main^{commit}": { stdout: "base111\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner).create("BP-1", "worker");

    expect(result.baseSha).toBe("base111");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "bp-1/worker", "/worktrees/BP-1", "base111"],
      expect.anything(),
    );
  });

  it("refuses when the base branch does not resolve", async () => {
    const { runner } = fakeGit({
      "rev-parse --verify main^{commit}": { code: 128, stderr: "unknown revision" },
      "worktree list --porcelain": { stdout: "" },
    });
    await expect(createWorkspace(config, runner).create("BP-1", "worker")).rejects.toThrow(/base/i);
  });

  it("neutralises system and repository git config on every call it makes", async () => {
    const { runner, run } = runnerReturning();
    await createWorkspace(config, runner).create("CP-158", "worker");

    for (const call of run.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });

  it("fetches the base before resolving it, when given a remote env provider", async () => {
    const { runner, run } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { stdout: "fresh1\trefs/heads/main\n" },
      "fetch --no-tags origin main": { stdout: "" },
      "rev-parse --verify fresh1^{commit}": { stdout: "fresh1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}));

    const result = await workspace.create("BP-1", "worker");

    expect(run.mock.calls.map((call) => call[1].join(" "))).toContainEqual(
      expect.stringContaining("fetch --no-tags origin main"),
    );
    expect(result.baseSha).toBe("fresh1");
  });

  it("does not fetch at all without a remote env provider", async () => {
    const { runner, run } = fakeGit({
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner).create("BP-1", "worker");

    expect(result.baseSha).toBe("local1");
    expect(run.mock.calls.some((call) => call[1].includes("fetch"))).toBe(false);
  });

  it("resolves the sha ls-remote reported, not whatever fetch left behind in FETCH_HEAD or the remote-tracking ref — both are files the agent can also write", async () => {
    const { runner, run } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { stdout: "genuine1\trefs/heads/main\n" },
      "fetch --no-tags origin main": { stdout: "" },
      "rev-parse --verify genuine1^{commit}": { stdout: "genuine1\n" },
      "rev-parse --verify FETCH_HEAD^{commit}": { stdout: "planted1\n" },
      "rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: "planted1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner, () => ({})).create(
      "BP-1",
      "worker",
    );

    expect(result.baseSha).toBe("genuine1");
    expect(run.mock.calls.some((call) => call[1].join(" ").includes("FETCH_HEAD"))).toBe(false);
  });

  it("falls back to the local ref when the fetch fails, rather than stopping the run", async () => {
    const { runner } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { stdout: "fresh1\trefs/heads/main\n" },
      "fetch --no-tags origin main": { code: 1, stderr: "could not resolve host" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}));

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("falls back to the local ref when ls-remote itself fails, rather than stopping the run", async () => {
    const { runner } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { code: 128, stderr: "could not resolve host" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}));

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("falls back to the local ref when the fetched sha does not verify locally afterwards", async () => {
    const { runner } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { stdout: "unreachable1\trefs/heads/main\n" },
      "fetch --no-tags origin main": { stdout: "" },
      "rev-parse --verify unreachable1^{commit}": { code: 128, stderr: "unknown revision" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}));

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("carries the given remote env and network-only credentials on the ls-remote and fetch calls, but not on local git calls", async () => {
    const { runner, run } = fakeGit({
      "ls-remote --exit-code origin refs/heads/main": { stdout: "fresh1\trefs/heads/main\n" },
      "fetch --no-tags origin main": { stdout: "" },
      "rev-parse --verify fresh1^{commit}": { stdout: "fresh1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    await createWorkspace(config, runner, () => ({ GH_TOKEN: "tok" })).create(
      "BP-1",
      "worker",
    );

    const remoteCalls = run.mock.calls.filter(
      (call) => call[1].includes("ls-remote") || (call[1].includes("fetch") && call[1].includes("origin")),
    );
    expect(remoteCalls).not.toHaveLength(0);
    for (const call of remoteCalls) {
      expect(call[2].env?.GH_TOKEN).toBe("tok");
    }

    const localCalls = run.mock.calls.filter((call) => call[1].includes("worktree"));
    for (const call of localCalls) {
      expect(call[2].env?.GH_TOKEN).toBeUndefined();
    }
  });

  it("throws when git fails to create the worktree", async () => {
    const { runner } = fakeGit({
      "rev-parse --verify main^{commit}": { stdout: "base1\n" },
      "worktree add -B cp-158/worker /worktrees/CP-158 base1": { code: 1, stderr: "exists" },
    });
    await expect(createWorkspace(config, runner).create("CP-158", "worker")).rejects.toThrow(
      /exists/,
    );
  });

  it("removes a leftover worktree from a crashed previous attempt before recreating it", async () => {
    let worktreeExists = true;
    const run = vi.fn(async (_command: string, rawArgs: string[]): Promise<CommandResult> => {
      const args = rawArgs.slice(HARDENING_PREFIX.length);
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "base9\n", stderr: "", timedOut: false };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: worktreeExists ? "worktree /worktrees/CP-158\n" : "",
          stderr: "",
          timedOut: false,
        };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        worktreeExists = false;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        if (worktreeExists) {
          return {
            code: 1,
            stdout: "",
            stderr: "'cp-158/worker' is already used by worktree at /worktrees/CP-158",
            timedOut: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });

    const result = await createWorkspace(config, { run }).create("CP-158", "worker");

    expect(result.path).toBe("/worktrees/CP-158");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "cp-158/worker", "/worktrees/CP-158", "base9"],
      expect.anything(),
    );
  });

  it("removes an existing worktree", async () => {
    const { runner, run } = fakeGit({
      "worktree list --porcelain": { stdout: "worktree /worktrees/CP-158\n" },
    });
    await createWorkspace(config, runner).destroy("CP-158");

    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("is a no-op when the worktree is already gone", async () => {
    const { runner, run } = runnerReturning();
    await expect(createWorkspace(config, runner).destroy("CP-158")).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("propagates a genuine removal failure instead of swallowing it", async () => {
    const { runner } = fakeGit({
      "worktree list --porcelain": { stdout: "worktree /worktrees/CP-158\n" },
      "worktree remove --force /worktrees/CP-158": { code: 1, stderr: "permission denied" },
    });
    await expect(createWorkspace(config, runner).destroy("CP-158")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("parses existing worktree paths", async () => {
    const { runner } = runnerReturning(
      "worktree /repo\n\nworktree /worktrees/CP-1\n\nworktree /worktrees/CP-2\n",
    );
    expect(await createWorkspace(config, runner).listWorktrees()).toEqual([
      "/repo",
      "/worktrees/CP-1",
      "/worktrees/CP-2",
    ]);
  });

  it("keeps spaces inside a worktree path intact, ignoring unrelated porcelain fields", async () => {
    const { runner } = runnerReturning(
      "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
        "worktree /worktrees/CP 42\nHEAD def456\nbranch refs/heads/cp-42/worker\n",
    );
    expect(await createWorkspace(config, runner).listWorktrees()).toEqual([
      "/repo",
      "/worktrees/CP 42",
    ]);
  });

  it("produces a clear error when a git call times out, instead of an empty one", async () => {
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });
    await expect(createWorkspace(config, { run }).listWorktrees()).rejects.toThrow(/timed out/);
  });
});

describe("reapOrphans", () => {
  function workspaceListing(paths: string[]): Workspace & { destroy: ReturnType<typeof vi.fn> } {
    return {
      create: vi.fn<Workspace["create"]>(),
      destroy: vi.fn<Workspace["destroy"]>().mockResolvedValue(undefined),
      listWorktrees: vi.fn<Workspace["listWorktrees"]>().mockResolvedValue(paths),
    };
  }

  it("removes every worktree left under the worker's own root", async () => {
    const workspace = workspaceListing(["/repo", "/worktrees/CP-1", "/worktrees/CP-2"]);

    expect(await reapOrphans(workspace, "/worktrees")).toBe(2);
    expect(workspace.destroy.mock.calls.map(([key]) => key)).toEqual(["CP-1", "CP-2"]);
  });

  // "/worktrees-archive" starts with "/worktrees" as a string but is a different directory
  it("leaves a sibling directory whose name merely starts the same alone", async () => {
    const workspace = workspaceListing(["/worktrees-archive/CP-1", "/worktrees.bak/CP-2"]);

    expect(await reapOrphans(workspace, "/worktrees")).toBe(0);
    expect(workspace.destroy).not.toHaveBeenCalled();
  });

  it("leaves the repository checkout and every worktree outside the root alone", async () => {
    const workspace = workspaceListing(["/repo", "/repo/.claude/worktrees/cp-158"]);

    expect(await reapOrphans(workspace, "/worktrees")).toBe(0);
    expect(workspace.destroy).not.toHaveBeenCalled();
  });

  it("ignores a nested path that names no task of its own", async () => {
    const workspace = workspaceListing(["/worktrees/CP-1/inner", "/worktrees/"]);

    expect(await reapOrphans(workspace, "/worktrees")).toBe(0);
  });

  it("reports nothing to reap when the worktree list cannot be read", async () => {
    const workspace = workspaceListing([]);
    workspace.listWorktrees = vi.fn<Workspace["listWorktrees"]>().mockRejectedValue(new Error("no git"));

    expect(await reapOrphans(workspace, "/worktrees")).toBe(0);
  });

  it("keeps reaping after one removal fails", async () => {
    const workspace = workspaceListing(["/worktrees/CP-1", "/worktrees/CP-2"]);
    workspace.destroy.mockRejectedValueOnce(new Error("locked"));

    expect(await reapOrphans(workspace, "/worktrees")).toBe(2);
    expect(workspace.destroy).toHaveBeenCalledTimes(2);
  });
});

describe("a task key that is not a name this worker can use", () => {
  it("refuses to build a worktree path outside the worktree root", async () => {
    const { runner, run } = runnerReturning();

    await expect(createWorkspace(config, runner).create("../escape-1", "worker")).rejects.toThrow(
      /worktree root/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the same path on destroy", async () => {
    const { runner, run } = runnerReturning();

    await expect(createWorkspace(config, runner).destroy("../escape-1")).rejects.toThrow(
      /worktree root/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
