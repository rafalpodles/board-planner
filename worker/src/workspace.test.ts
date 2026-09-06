import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";
import { createWorkspace, reapOrphans, Workspace } from "./workspace.js";
import { CommandResult, RunOpts } from "./exec.js";
import { gitArgs } from "./git-safety.js";
import { scopedConfigListZ } from "./config-list.fixtures.js";

const REPO_PATH = "/repo";

const config = {
  repoPath: REPO_PATH,
  worktreeRoot: "/worktrees",
  baseBranch: "main",
} as never;

function runnerReturning(stdout = "") {
  const run = vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false });
  return { runner: { run }, run };
}

const HARDENING_PREFIX = gitArgs([]);
const REMOTE_URL = "https://git.example/acme/repo.git";
const LS_REMOTE = `ls-remote -- ${REMOTE_URL} refs/heads/main`;
const FETCH = `fetch --no-tags -- ${REMOTE_URL} main`;
const LOCAL_REF = "rev-parse --verify main^{commit}";
const CONFIG_LIST = "config --list -z --show-scope --no-includes";

function fakeGit(responses: Record<string, Partial<CommandResult>>) {
  const run = vi.fn(async (_command: string, args: string[], _opts: RunOpts): Promise<CommandResult> => {
    const hardened = HARDENING_PREFIX.every((flag, index) => args[index] === flag);
    const key = (hardened ? args.slice(HARDENING_PREFIX.length) : args).join(" ");
    const override = responses[key];
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...override };
  });
  return { runner: { run }, run };
}

function baseFromRemote(sha: string, extra: Record<string, Partial<CommandResult>> = {}) {
  return {
    [LS_REMOTE]: { stdout: `${sha}\trefs/heads/main\n` },
    [FETCH]: { stdout: "" },
    [`rev-parse --verify ${sha}^{commit}`]: { stdout: `${sha}\n` },
    "worktree list --porcelain": { stdout: "" },
    ...extra,
  };
}

function withRemote(runner: Parameters<typeof createWorkspace>[1], env: () => NodeJS.ProcessEnv = () => ({})) {
  return createWorkspace(config, runner, env, REMOTE_URL);
}

function ranAny(run: { mock: { calls: unknown[][] } }, fragment: string): boolean {
  return run.mock.calls.some((call) => (call[1] as string[]).join(" ").includes(fragment));
}

function readsLocalRef(run: { mock: { calls: unknown[][] } }): boolean {
  return run.mock.calls.some((call) => (call[1] as string[]).join(" ").includes(LOCAL_REF));
}

describe("createWorkspace", () => {
  it("creates a worktree on a task-keyed branch", async () => {
    const { runner, run } = fakeGit(baseFromRemote("base1"));
    const result = await withRemote(runner).create("CP-158", "worker");

    expect(result.path).toBe("/worktrees/CP-158");
    expect(result.baseSha).toBe("base1");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "cp-158/worker", "--", "/worktrees/CP-158", "base1"],
      expect.objectContaining({ cwd: "/repo", env: expect.objectContaining({ GIT_CONFIG_NOSYSTEM: "1" }) }),
    );
    expect(run).not.toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "--", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("creates the worktree at a sha resolved before the agent could run", async () => {
    const { runner, run } = fakeGit(baseFromRemote("base111"));
    const result = await withRemote(runner).create("BP-1", "worker");

    expect(result.baseSha).toBe("base111");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "bp-1/worker", "--", "/worktrees/BP-1", "base111"],
      expect.anything(),
    );
  });

  it("refuses when the base branch does not resolve", async () => {
    const { runner } = fakeGit(
      baseFromRemote("base1", {
        "rev-parse --verify base1^{commit}": { code: 128, stderr: "unknown revision" },
      })
    );
    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/base/i);
  });

  it("neutralises system and repository git config on every local call it makes", async () => {
    const { runner, run } = fakeGit(baseFromRemote("base1"));
    await withRemote(runner).create("CP-158", "worker");

    const localCalls = run.mock.calls.filter(
      (call) => call[1][0] !== "ls-remote" && call[1][0] !== "fetch"
    );
    expect(localCalls).not.toHaveLength(0);
    for (const call of localCalls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env?.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });

  it("fetches the base before resolving it", async () => {
    const { runner, run } = fakeGit(baseFromRemote("fresh1"));

    const result = await withRemote(runner).create("BP-1", "worker");

    expect(run.mock.calls.map((call) => call[1].join(" "))).toContainEqual(
      expect.stringContaining(FETCH),
    );
    expect(result.baseSha).toBe("fresh1");
  });

  it("asks the remote from a directory it creates, with discovery switched off", async () => {
    const { runner, run } = fakeGit(baseFromRemote("fresh1"));
    await withRemote(runner).create("BP-1", "worker");

    const [, , opts] = run.mock.calls.find((call) => call[1][0] === "ls-remote")!;
    expect(opts.cwd).not.toBe("/repo");
    expect(opts.cwd).not.toBe(tmpdir());
    expect(opts.cwd?.startsWith(tmpdir())).toBe(true);
    expect(opts.env?.GIT_DIR?.startsWith(opts.cwd!)).toBe(true);
    expect(opts.env?.GIT_CEILING_DIRECTORIES).toBe(tmpdir());
  });

  it("does not read a repository planted in the lookup directory itself", async () => {
    let discovered = "";
    const responses = baseFromRemote("fresh1");
    const run = vi.fn(async (_command: string, args: string[], opts: RunOpts): Promise<CommandResult> => {
      if (args[0] === "ls-remote") {
        const cwd = opts.cwd!;
        mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
        mkdirSync(join(cwd, ".git", "refs"), { recursive: true });
        writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(
          join(cwd, ".git", "config"),
          "[core]\n\trepositoryformatversion = 0\n[bp]\n\tmarker = planted\n"
        );
        try {
          discovered = execFileSync("git", ["config", "--get", "bp.marker"], {
            cwd,
            env: { PATH: process.env.PATH, ...opts.env } as NodeJS.ProcessEnv,
            stdio: "pipe",
          })
            .toString()
            .trim();
        } catch {
          discovered = "";
        }
      }
      const hardened = HARDENING_PREFIX.every((flag, index) => args[index] === flag);
      const key = (hardened ? args.slice(HARDENING_PREFIX.length) : args).join(" ");
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...responses[key] };
    });

    await withRemote({ run }).create("BP-1", "worker");

    expect(discovered).toBe("");
  });

  it("removes the directory it created for the lookup", async () => {
    const { runner, run } = fakeGit(baseFromRemote("fresh1"));
    await withRemote(runner).create("BP-1", "worker");

    const [, , opts] = run.mock.calls.find((call) => call[1][0] === "ls-remote")!;
    expect(existsSync(opts.cwd!)).toBe(false);
  });

  it("removes that directory even when the lookup fails", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("fresh1", { [LS_REMOTE]: { code: 128, stderr: "boom" } })
    );
    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/boom/);

    const [, , opts] = run.mock.calls.find((call) => call[1][0] === "ls-remote")!;
    expect(existsSync(opts.cwd!)).toBe(false);
  });

  it("says a remote call timed out rather than reporting an empty failure", async () => {
    const { runner } = fakeGit(
      baseFromRemote("fresh1", { [LS_REMOTE]: { code: 143, timedOut: true } })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/timed out after/);
  });

  it("refuses to run at all when no remote is configured, rather than reading the local ref", async () => {
    for (const env of [undefined, () => ({})]) {
      const { runner, run } = fakeGit(baseFromRemote("local1"));
      const workspace = createWorkspace(config, runner, env, env ? undefined : REMOTE_URL);
      await expect(workspace.create("BP-1", "worker")).rejects.toThrow(/no remote is configured/);
      expect(readsLocalRef(run)).toBe(false);
    }
  });

  it("fetches the pinned URL directly rather than a remote name — a name would resolve through repoPath/.git/config's own remote.origin.url, which the agent can rewrite", async () => {
    const { runner, run } = fakeGit(baseFromRemote("genuine1"));
    await withRemote(runner).create("BP-1", "worker");

    const remoteCalls = run.mock.calls.filter(
      (call) => call[1][0] === "ls-remote" || call[1][0] === "fetch"
    );
    expect(remoteCalls).toHaveLength(2);
    for (const call of remoteCalls) expect(call[1]).toContain(REMOTE_URL);
    expect(run.mock.calls.some((call) => call[1].includes("origin"))).toBe(false);
  });

  it("resolves the sha ls-remote reported, not whatever fetch left behind in FETCH_HEAD or a remote-tracking ref — both are files the agent can also write", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("genuine1", {
        "rev-parse --verify FETCH_HEAD^{commit}": { stdout: "planted1\n" },
        "rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: "planted1\n" },
      })
    );
    const result = await withRemote(runner).create("BP-1", "worker");

    expect(result.baseSha).toBe("genuine1");
    expect(run.mock.calls.some((call) => call[1].join(" ").includes("FETCH_HEAD"))).toBe(false);
  });

  it("takes the sha of the exact ref, not the first line ls-remote happens to print", async () => {
    const { runner } = fakeGit(
      baseFromRemote("genuine1", {
        [LS_REMOTE]: {
          stdout: "decoy1\trefs/heads/aaa/refs/heads/main\ngenuine1\trefs/heads/main\n",
        },
      })
    );

    expect((await withRemote(runner).create("BP-1", "worker")).baseSha).toBe("genuine1");
  });

  it("refuses when the remote reports no exact match at all", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("genuine1", {
        [LS_REMOTE]: { stdout: "decoy1\trefs/heads/aaa/refs/heads/main\n" },
      })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/did not report/);
    expect(readsLocalRef(run)).toBe(false);
  });

  it("calls a remote that answered without the ref a configuration fault, not a transport one", async () => {
    const { runner } = fakeGit(
      baseFromRemote("genuine1", {
        [LS_REMOTE]: { stdout: "decoy1\trefs/heads/aaa/refs/heads/main\n" },
      })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toMatchObject({
      kind: "configuration",
    });
  });

  it("calls a checkout with no remote at all a configuration fault", async () => {
    const { runner } = fakeGit(baseFromRemote("base1"));

    await expect(
      createWorkspace(config, runner).create("BP-1", "worker")
    ).rejects.toMatchObject({ kind: "configuration" });
  });

  it("calls a remote that could not be reached a transport fault, so the worker backs off instead", async () => {
    const { runner } = fakeGit(
      baseFromRemote("fresh1", { [LS_REMOTE]: { code: 128, stderr: "could not resolve host" } })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toMatchObject({
      kind: "transport",
    });
  });

  it("fails the run when the fetch fails, and never reads the local ref", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("fresh1", { [FETCH]: { code: 1, stderr: "could not resolve host" } })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/could not resolve host/);
    expect(readsLocalRef(run)).toBe(false);
  });

  it("fails the run when ls-remote itself fails, and never reads the local ref", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("fresh1", { [LS_REMOTE]: { code: 128, stderr: "could not resolve host" } })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/could not resolve host/);
    expect(readsLocalRef(run)).toBe(false);
  });

  it("fails the run when the fetched sha does not verify locally afterwards, and never reads the local ref", async () => {
    const { runner, run } = fakeGit(
      baseFromRemote("unreachable1", {
        "rev-parse --verify unreachable1^{commit}": { code: 128, stderr: "unknown revision" },
      })
    );

    await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow(/unknown revision/);
    expect(readsLocalRef(run)).toBe(false);
  });

  it("composes the ls-remote and fetch calls without any -c flags, so a credential helper the env provider installs cannot be reset by one riding along", async () => {
    const { runner, run } = fakeGit(baseFromRemote("fresh1"));
    await withRemote(runner, () => ({ GH_TOKEN: "tok" })).create("BP-1", "worker");

    const remoteCallArgs = run.mock.calls
      .filter((call) => call[1][0] === "ls-remote" || call[1][0] === "fetch")
      .map((call) => call[1]);
    expect(remoteCallArgs).toEqual([
      ["ls-remote", "--", REMOTE_URL, "refs/heads/main"],
      ["fetch", "--no-tags", "--", REMOTE_URL, "main"],
    ]);

    for (const call of run.mock.calls.filter((c) => c[1][0] === "ls-remote" || c[1][0] === "fetch")) {
      expect(call[2].env?.GH_TOKEN).toBe("tok");
    }
  });

  it("carries the given remote env and network-only credentials on the ls-remote and fetch calls, but not on local git calls, and keeps GIT_NO_REPLACE_OBJECTS even when the caller's env provider forgets it", async () => {
    const { runner, run } = fakeGit(baseFromRemote("fresh1"));
    await withRemote(runner, () => ({ GH_TOKEN: "tok" })).create("BP-1", "worker");

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

  describe("a checkout whose config carries an executable key", () => {
    const PLANTED = {
      [CONFIG_LIST]: { stdout: scopedConfigListZ("filter.z.smudge=touch /tmp/pwned") },
    };

    it("is refused, naming the key", async () => {
      const { runner } = fakeGit(baseFromRemote("base1", PLANTED));

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toMatchObject({
        name: "PoisonedCheckoutError",
        message: expect.stringContaining("filter.z.smudge"),
      });
    });

    it("is refused before anything is checked out", async () => {
      const { runner, run } = fakeGit(baseFromRemote("base1", PLANTED));

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow();

      expect(ranAny(run, "worktree add"), "the worktree was created anyway").toBe(false);
    });

    it("is refused before the remote is asked anything", async () => {
      const { runner, run } = fakeGit(baseFromRemote("base1", PLANTED));

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow();

      expect(ranAny(run, "ls-remote"), "the remote was asked for the base ref").toBe(false);
      expect(ranAny(run, "fetch"), "the poisoned clone was fetched into").toBe(false);
    });

    it("asks the shared checkout, which is where the key lives", async () => {
      const { runner, run } = fakeGit(baseFromRemote("base1", PLANTED));

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toThrow();

      const scan = run.mock.calls.find((call) =>
        (call[1] as string[]).join(" ").includes("config --list -z --show-scope")
      );
      expect((scan?.[2] as { cwd?: string })?.cwd).toBe(REPO_PATH);
    });

    it("reads the config again immediately before checking anything out", async () => {
      let listings = 0;
      const run = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
        const key = args.slice(HARDENING_PREFIX.length).join(" ");
        const answer = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
        if (key === CONFIG_LIST) {
          listings += 1;
          return answer(listings === 1 ? "" : scopedConfigListZ("filter.z.smudge=touch /tmp/pwned"));
        }
        if (key === "worktree list --porcelain") return answer("");
        if (args.join(" ") === LS_REMOTE) return answer("base1\trefs/heads/main\n");
        if (args.join(" ") === FETCH) return answer();
        if (key === "rev-parse --verify base1^{commit}") return answer("base1\n");
        return answer();
      });

      await expect(withRemote({ run }).create("BP-1", "worker")).rejects.toMatchObject({
        name: "PoisonedCheckoutError",
      });

      expect(listings, "the config was read only once").toBeGreaterThan(1);
      expect(ranAny(run, "worktree add"), "the checkout happened anyway").toBe(false);
    });

    it("still creates the worktree when the config carries nothing executable", async () => {
      const { runner, run } = fakeGit(
        baseFromRemote("base1", {
          [CONFIG_LIST]: { stdout: scopedConfigListZ("core.bare=false\nfilter.z.required=true") },
        })
      );

      const worktree = await withRemote(runner).create("BP-1", "worker");

      expect(worktree.baseSha).toBe("base1");
      expect(ranAny(run, "worktree add")).toBe(true);
    });

    it("is refused when the config cannot be read at all", async () => {
      const { runner, run } = fakeGit(
        baseFromRemote("base1", { "config --local --list": { code: 128, stderr: "not a repository" } })
      );

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toMatchObject({
        name: "PoisonedCheckoutError",
        kind: "unreadable",
      });
      expect(ranAny(run, "worktree add")).toBe(false);
    });

    it("calls a key somebody planted planted, from the same path", async () => {
      const { runner } = fakeGit(baseFromRemote("base1", PLANTED));

      await expect(withRemote(runner).create("BP-1", "worker")).rejects.toMatchObject({
        name: "PoisonedCheckoutError",
        kind: "planted",
      });
    });
  });

  it("throws when git fails to create the worktree", async () => {
    const { runner } = fakeGit(
      baseFromRemote("base1", {
        "worktree add -B cp-158/worker -- /worktrees/CP-158 base1": { code: 1, stderr: "exists" },
      })
    );
    await expect(withRemote(runner).create("CP-158", "worker")).rejects.toThrow(/exists/);
  });

  it("removes a leftover worktree from a crashed previous attempt before recreating it", async () => {
    let worktreeExists = true;
    const run = vi.fn(async (_command: string, rawArgs: string[]): Promise<CommandResult> => {
      if (rawArgs[0] === "ls-remote") {
        return { code: 0, stdout: "base9\trefs/heads/main\n", stderr: "", timedOut: false };
      }
      if (rawArgs[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
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

    const result = await withRemote({ run }).create("CP-158", "worker");

    expect(result.path).toBe("/worktrees/CP-158");
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "--", "/worktrees/CP-158"],
      expect.anything(),
    );
    expect(run).toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "add", "-B", "cp-158/worker", "--", "/worktrees/CP-158", "base9"],
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
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "--", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("is a no-op when the worktree is already gone", async () => {
    const { runner, run } = runnerReturning();
    await expect(createWorkspace(config, runner).destroy("CP-158")).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalledWith(
      "git",
      [...HARDENING_PREFIX, "worktree", "remove", "--force", "--", "/worktrees/CP-158"],
      expect.anything(),
    );
  });

  it("propagates a genuine removal failure instead of swallowing it", async () => {
    const { runner } = fakeGit({
      "worktree list --porcelain": { stdout: "worktree /worktrees/CP-158\n" },
      "worktree remove --force -- /worktrees/CP-158": { code: 1, stderr: "permission denied" },
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
