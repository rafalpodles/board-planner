import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine } from "./sandbox.js";
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
    const spawn = confine("/bin/sh", ["-c", script], { writable: [worktree] });
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
    });
    if (!("command" in spawn)) throw new Error(`refused: ${spawn.refusal}`);
    const result = await runner.run(spawn.command, spawn.args, { cwd: dir, timeoutMs: 30_000 });

    expect(result.code).toBe(0);
    expect(readFileSync(join(worktree, "through.txt"), "utf8")).toBe("via-link\n");
  });
});
