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

// Every local call carries the hardening flags gitArgs prepends — stripped here so the response
// maps below keep naming the real git subcommand. What those flags ARE is git-safety.test.ts's
// subject; taking them from the same source is what stops this file breaking every time one is
// added. The ls-remote/fetch calls carry no such prefix (workspace.ts composes their env instead
// of their args — see workspace.ts's runRemote), so responses key on the raw args for those.
const HARDENING_PREFIX = gitArgs([]);
const REMOTE_URL = "https://git.example/acme/repo.git";

function fakeGit(responses: Record<string, Partial<CommandResult>>) {
  const run = vi.fn(async (_command: string, args: string[], _opts: RunOpts): Promise<CommandResult> => {
    const hardened = HARDENING_PREFIX.every((flag, index) => args[index] === flag);
    const key = (hardened ? args.slice(HARDENING_PREFIX.length) : args).join(" ");
    const override = responses[key];
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

  it("fetches the base before resolving it, when given a remote env provider and a pinned URL", async () => {
    const { runner, run } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "fresh1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify fresh1^{commit}": { stdout: "fresh1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}), REMOTE_URL);

    const result = await workspace.create("BP-1", "worker");

    expect(run.mock.calls.map((call) => call[1].join(" "))).toContainEqual(
      expect.stringContaining(`fetch --no-tags ${REMOTE_URL} main`),
    );
    expect(result.baseSha).toBe("fresh1");
  });

  it("does not fetch at all without a remote env provider", async () => {
    const { runner, run } = fakeGit({
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner, undefined, REMOTE_URL).create("BP-1", "worker");

    expect(result.baseSha).toBe("local1");
    expect(run.mock.calls.some((call) => call[1].includes("fetch"))).toBe(false);
  });

  it("does not fetch at all without a pinned URL, even with a remote env provider", async () => {
    const { runner, run } = fakeGit({
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner, () => ({})).create("BP-1", "worker");

    expect(result.baseSha).toBe("local1");
    expect(run.mock.calls.some((call) => call[1].includes("fetch"))).toBe(false);
  });

  it("fetches the pinned URL directly rather than a remote name — a name would resolve through repoPath/.git/config's own remote.origin.url, which the agent can rewrite", async () => {
    const { runner, run } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "genuine1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify genuine1^{commit}": { stdout: "genuine1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    await createWorkspace(config, runner, () => ({}), REMOTE_URL).create("BP-1", "worker");

    expect(run.mock.calls.some((call) => call[1].includes("origin"))).toBe(false);
  });

  it("resolves the sha ls-remote reported, not whatever fetch left behind in FETCH_HEAD or a remote-tracking ref — both are files the agent can also write", async () => {
    const { runner, run } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "genuine1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify genuine1^{commit}": { stdout: "genuine1\n" },
      "rev-parse --verify FETCH_HEAD^{commit}": { stdout: "planted1\n" },
      "rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: "planted1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const result = await createWorkspace(config, runner, () => ({}), REMOTE_URL).create("BP-1", "worker");

    expect(result.baseSha).toBe("genuine1");
    expect(run.mock.calls.some((call) => call[1].join(" ").includes("FETCH_HEAD"))).toBe(false);
  });

  it("falls back to the local ref when the fetch fails, rather than stopping the run", async () => {
    const { runner } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "fresh1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { code: 1, stderr: "could not resolve host" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}), REMOTE_URL);

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("falls back to the local ref when ls-remote itself fails, rather than stopping the run", async () => {
    const { runner } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { code: 128, stderr: "could not resolve host" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}), REMOTE_URL);

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("falls back to the local ref when the fetched sha does not verify locally afterwards", async () => {
    const { runner } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "unreachable1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify unreachable1^{commit}": { code: 128, stderr: "unknown revision" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const workspace = createWorkspace(config, runner, () => ({}), REMOTE_URL);

    expect((await workspace.create("BP-1", "worker")).baseSha).toBe("local1");
  });

  it("logs through the injected log function, defaulting to none of the above, when the fetch falls back", async () => {
    const { runner } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { code: 128, stderr: "could not resolve host" },
      "rev-parse --verify main^{commit}": { stdout: "local1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    const log = vi.fn();
    const workspace = createWorkspace(config, runner, () => ({}), REMOTE_URL, log);

    await workspace.create("BP-1", "worker");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/could not resolve host/);
  });

  // The regression this exists to catch: workspace.ts used to build these two calls with
  // gitArgs(), which appends `-c credential.helper=` as the last thing git evaluates. For this
  // specific multi-valued key that silently discards whatever the env-based provider installed —
  // verified empirically against a real git binary (see task-8 fix-round report) — so the fetch
  // could never authenticate over https and always, silently, fell back. A test that only checks
  // "fetch was called" cannot see this; it has to look at the actual argument vector.
  it("composes the ls-remote and fetch calls without any -c flags, so a credential helper the env provider installs cannot be reset by one riding along", async () => {
    const { runner, run } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "fresh1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify fresh1^{commit}": { stdout: "fresh1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    await createWorkspace(config, runner, () => ({ GH_TOKEN: "tok" }), REMOTE_URL).create("BP-1", "worker");

    const remoteCallArgs = run.mock.calls
      .filter((call) => call[1][0] === "ls-remote" || call[1][0] === "fetch")
      .map((call) => call[1]);
    expect(remoteCallArgs).toEqual([
      ["ls-remote", "--exit-code", REMOTE_URL, "refs/heads/main"],
      ["fetch", "--no-tags", REMOTE_URL, "main"],
    ]);

    for (const call of run.mock.calls.filter((c) => c[1][0] === "ls-remote" || c[1][0] === "fetch")) {
      expect(call[2].env?.GH_TOKEN).toBe("tok");
    }
  });

  it("carries the given remote env and network-only credentials on the ls-remote and fetch calls, but not on local git calls, and keeps GIT_NO_REPLACE_OBJECTS even when the caller's env provider forgets it", async () => {
    const { runner, run } = fakeGit({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { stdout: "fresh1\trefs/heads/main\n" },
      [`fetch --no-tags ${REMOTE_URL} main`]: { stdout: "" },
      "rev-parse --verify fresh1^{commit}": { stdout: "fresh1\n" },
      "worktree list --porcelain": { stdout: "" },
    });
    await createWorkspace(config, runner, () => ({ GH_TOKEN: "tok" }), REMOTE_URL).create("BP-1", "worker");

    const remoteCalls = run.mock.calls.filter(
      (call) => call[1][0] === "ls-remote" || call[1][0] === "fetch",
    );
    expect(remoteCalls).not.toHaveLength(0);
    for (const call of remoteCalls) {
      expect(call[2].env?.GH_TOKEN).toBe("tok");
      expect(call[2].env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(call[2].env?.GIT_CONFIG_NOSYSTEM).toBe("1");
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
