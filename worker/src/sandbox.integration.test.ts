import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine } from "./sandbox.js";
import { UNCONFINED_ESCAPE_HATCH } from "./env.js";
import { createRunner } from "./exec.js";

/**
 * The profile driven through the real kernel. Every claim in sandbox.ts is about what seatbelt
 * permits, and a test over the profile string can only say the string was composed — which is
 * exactly the shape of assertion that let BP-349 stand open while `~/.claude` was named as
 * sensitive in repos.ts.
 *
 * Skipped off macOS rather than failing: there is no seatbelt to ask, and `confine` already refuses
 * there — a refusal the unit suite pins.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("confine against the real sandbox", () => {
  let dir: string;
  let worktree: string;
  let outside: string;

  const runner = createRunner();

  async function confinedSh(script: string) {
    // env: {} so the operator's own risk acceptance cannot switch off the thing under test
    const spawn = confine("/bin/sh", ["-c", script], { writable: [worktree], env: {} });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    return runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp349-"));
    worktree = join(dir, "worktree");
    outside = join(dir, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "original\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the agent write inside the worktree it was given", async () => {
    const result = await confinedSh(`echo edited > ${worktree}/file.txt`);

    expect(result.code).toBe(0);
    expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("edited\n");
  });

  // The escape BP-349 is about, with `$HOME/.claude/settings.json` played by a file this test owns:
  // overwriting a file that already exists, outside the one directory the profile allows.
  it("refuses a write to a file outside it, and leaves that file alone", async () => {
    const result = await confinedSh(`echo planted > ${outside}/settings.json`);

    expect(result.code).not.toBe(0);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  it("refuses to create a new file outside it", async () => {
    await confinedSh(`echo planted > ${outside}/hook.sh`);

    expect(existsSync(join(outside, "hook.sh"))).toBe(false);
  });

  it("refuses to delete a file outside it", async () => {
    await confinedSh(`rm -f ${outside}/settings.json`);

    expect(existsSync(join(outside, "settings.json"))).toBe(true);
  });

  // The agent holds Write inside the worktree, so it can put a symlink there and write through it.
  // Seatbelt matching the resolved vnode rather than the path it was handed is the reason this
  // does not reopen the whole thing — asserted rather than assumed, because it is the difference
  // between a confinement and a speed bump (same family as BP-428).
  it("refuses a write through a symlink that leaves the worktree", async () => {
    symlinkSync(outside, join(worktree, "escape"));

    const result = await confinedSh(`echo planted > ${worktree}/escape/settings.json`);

    expect(result.code).not.toBe(0);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  // A child process inherits the sandbox. Without that the confinement would end at the first
  // thing the CLI spawns, which is most of what it does.
  it("holds for a grandchild process, not only the command it wrapped", async () => {
    await confinedSh(`/bin/sh -c "echo planted > ${outside}/grandchild.txt"`);

    expect(existsSync(join(outside, "grandchild.txt"))).toBe(false);
  });

  // `/tmp` is a symlink to `/private/tmp` on macOS, and mkdtemp hands back the `/var/folders/…`
  // form that resolves elsewhere again. A profile built from the unresolved path denies the
  // worktree write — the failure looks like the sandbox working, which is why it is pinned from
  // the permitted side as well as the denied one.
  it("resolves the worktree path, so a symlinked temp directory is still writable", async () => {
    const linked = join(dir, "linked");
    symlinkSync(worktree, linked);

    const spawn = confine("/bin/sh", ["-c", `echo via-link > ${linked}/through.txt`], {
      writable: [linked],
      env: {},
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const result = await runner.run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });

    expect(result.code).toBe(0);
    expect(readFileSync(join(worktree, "through.txt"), "utf8")).toBe("via-link\n");
  });

  /**
   * The write this process never performs: `defaults write` hands the domain to cfprefsd, which
   * runs outside the profile and wrote the plist under `~/Library/Preferences` on its behalf —
   * exit 0, with `file-write*` denied (BP-630).
   *
   * Asserted on the domain rather than on the exit code, and that is not a preference: measured,
   * a `defaults write` of a domain this machine has seen and deleted before exits **0 under the
   * deny while writing nothing at all**. Only asking cfprefsd what it holds tells the two apart,
   * and a test that watched the exit code would have called that pass a failure.
   *
   * The control runs the same command with the operator's escape hatch set, which is what makes
   * this pair capable of failing: without it a `defaults` that could not write for any other
   * reason reads exactly like a confinement that works. Each takes its own domain, because the
   * first one's write is what changes the second one's exit code.
   */
  describe("a write performed by a daemon on the process's behalf", () => {
    const domains: string[] = [];

    // Unique per test: two suites on one machine share ~/Library/Preferences, and a domain left
    // behind by a crashed earlier run must not decide this one.
    function probeDomain(): string {
      const domain = `com.board-planner.worker.sandbox-probe.${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      domains.push(domain);
      return domain;
    }

    const readDomain = (domain: string) =>
      runner.run("/usr/bin/defaults", ["read", domain], { cwd: worktree, timeoutMs: 30_000 });

    function writeAs(domain: string, env: NodeJS.ProcessEnv) {
      const spawn = confine("/usr/bin/defaults", ["write", domain, "planted", "yes"], {
        writable: [worktree],
        env,
      });
      if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
      return runner.run(spawn.command, spawn.args, { cwd: worktree, timeoutMs: 30_000 });
    }

    afterEach(async () => {
      for (const domain of domains.splice(0)) {
        await runner.run("/usr/bin/defaults", ["delete", domain], { cwd: worktree, timeoutMs: 30_000 });
      }
    });

    it("writes the preference when nothing confines it — the control", async () => {
      const domain = probeDomain();

      await writeAs(domain, { [UNCONFINED_ESCAPE_HATCH]: "1" });

      expect((await readDomain(domain)).stdout).toContain("planted");
    });

    it("leaves no preference behind under the profile", async () => {
      const domain = probeDomain();

      await writeAs(domain, {});

      expect((await readDomain(domain)).stdout).not.toContain("planted");
    });
  });
});
