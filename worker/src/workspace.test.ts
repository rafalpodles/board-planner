import { describe, it, expect, vi } from "vitest";
import { createWorkspace, reapOrphans, Workspace } from "./workspace.js";
import { CommandResult } from "./exec.js";

const config = {
  repoPath: "/repo",
  worktreeRoot: "/worktrees",
} as never;

function runnerReturning(stdout = "") {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false });
  return { runner: { run }, run };
}

function fakeGit(responses: Record<string, Partial<CommandResult>>) {
  const run = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
    const override = responses[args.join(" ")];
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...override };
  });
  return { runner: { run }, run };
}

describe("createWorkspace", () => {
  it("creates a worktree on a task-keyed branch", async () => {
    const { runner, run } = runnerReturning();
    const path = await createWorkspace(config, runner).create("CP-158", "worker");

    expect(path).toBe("/worktrees/CP-158");
    expect(run).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-B", "cp-158/worker", "/worktrees/CP-158"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(run).not.toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("throws when git fails to create the worktree", async () => {
    const { runner } = fakeGit({
      "worktree add -B cp-158/worker /worktrees/CP-158": { code: 1, stderr: "exists" },
    });
    await expect(createWorkspace(config, runner).create("CP-158", "worker")).rejects.toThrow(
      /exists/,
    );
  });

  it("removes a leftover worktree from a crashed previous attempt before recreating it", async () => {
    let worktreeExists = true;
    const run = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
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

    const path = await createWorkspace(config, { run }).create("CP-158", "worker");

    expect(path).toBe("/worktrees/CP-158");
    expect(run).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
    expect(run).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-B", "cp-158/worker", "/worktrees/CP-158"],
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
      ["worktree", "remove", "--force", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("is a no-op when the worktree is already gone", async () => {
    const { runner, run } = runnerReturning();
    await expect(createWorkspace(config, runner).destroy("CP-158")).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/worktrees/CP-158"],
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
