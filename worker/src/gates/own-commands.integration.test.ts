import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../exec.js";
import { claimedTask } from "../__fixtures__/task.js";
import { confine, recordDir } from "../sandbox.js";
import { GateContext } from "../types.js";
import { buildGate } from "./build.js";
import { gateCommandsOf, GateCommands } from "./gate-commands.js";
import { testRunGate } from "./test-run.js";

/**
 * BP-985, through the real kernel. What a project's own command runs is as agent-written as a test
 * file, so what matters is what the spawn cannot do, and only running it can say.
 */
const onMac = process.platform === "darwin";
const TIMEOUT_MS = 30_000;
const NOT_NPM = "/nonexistent/npm";

describe.skipIf(!onMac)("a project's own gate commands against the real sandbox", () => {
  let root = "";
  let worktree = "";
  let outside = "";
  let context: GateContext;
  const runner = createRunner();

  function script(name: string, body: string) {
    writeFileSync(join(worktree, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(worktree, name), 0o755);
  }

  const own = (commands: Partial<GateCommands>) => gateCommandsOf(commands);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bp985-int-")));
    worktree = join(root, "wt");
    outside = join(root, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    mkdirSync(join(root, "wt.home"));
    context = {
      worktreePath: worktree,
      worktreeDir: recordDir(worktree),
      gateHome: recordDir(join(root, "wt.home")),
      checkoutGitDir: join(root, "wt", ".git"),
      task: claimedTask({ title: "t", description: "d" }),
      result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
      diff: { changedLines: 1, changedFiles: ["a.py"], patch: "", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", symlinks: [], suppressedDiffs: [], gitlinks: [] },
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps what the install put in the home for the build and the test that follow", async () => {
    script("install.sh", 'mkdir -p "$HOME/deps" && echo fetched > "$HOME/deps/module"');
    script("build.sh", 'test "$(cat "$HOME/deps/module")" = fetched && echo built > built.txt');
    script("check.sh", 'test -f built.txt && test "$(cat "$HOME/deps/module")" = fetched');
    const commands = own({ installCommand: "./install.sh", buildCommand: "./build.sh", testCommand: "./check.sh" });

    const built = await buildGate(runner, NOT_NPM, TIMEOUT_MS, commands).run(context);
    const tested = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, commands).run(context);

    expect(built).toMatchObject({ ok: true, commands: ["./install.sh", "./build.sh"] });
    expect(tested).toMatchObject({ ok: true, commands: ["./check.sh"] });
  });

  it("cannot write outside the worktree, the home and its own temp, by path or through the real home", async () => {
    const realHome = join(homedir(), `.bp985-escape-${process.pid}`);
    script("escape.sh", `echo x > "${join(outside, "planted")}"; echo x > "${realHome}"; exit 0`);

    const verdict = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./escape.sh" })).run(context);

    expect(verdict.ok).toBe(true);
    expect(existsSync(join(outside, "planted"))).toBe(false);
    expect(existsSync(realHome)).toBe(false);
  });

  it("is told nothing of the worker's credentials", async () => {
    vi.stubEnv("CP_API_TOKEN", "secret-bp985");
    script("env.sh", 'env > "$PWD/seen.txt"');

    await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./env.sh" })).run(context);

    expect(readFileSync(join(worktree, "seen.txt"), "utf8")).not.toContain("secret-bp985");
  });

  describe("the real home, with the network open", () => {
    // TEST-NET-1: never routed, so an open network times out where a closed one answers EPERM at once
    const OFF_THE_MACHINE = `require('net').connect({ host: '192.0.2.1', port: 443, timeout: 1000 }).on('connect', () => process.exit(0)).on('timeout', () => process.exit(0)).on('error', (e) => { console.error(e.code); process.exit(e.code === 'EPERM' ? 1 : 0); })`;
    let canary = "";

    beforeEach(() => {
      canary = realpathSync(mkdtempSync(join(homedir(), ".bp985-canary-")));
      writeFileSync(join(canary, "id_ed25519"), "fake-secret-bp985\n");
    });

    afterEach(() => {
      rmSync(canary, { recursive: true, force: true });
    });

    it.each(["installCommand", "buildCommand", "testCommand"] as const)("lets %s reach off the machine", async (field) => {
      script("out.sh", `exec "${process.execPath}" -e "${OFF_THE_MACHINE}"`);
      const gate = field === "testCommand" ? testRunGate : buildGate;

      const verdict = await gate(runner, NOT_NPM, TIMEOUT_MS, own({ [field]: "./out.sh" })).run(context);

      expect(verdict).toMatchObject({ ok: true });
    });

    it.each(["installCommand", "buildCommand", "testCommand"] as const)("refuses %s a file in the real home, while the same file elsewhere reads", async (field) => {
      writeFileSync(join(worktree, "control"), "readable\n");
      script("steal.sh", `cat control > got.txt\ncat "${join(canary, "id_ed25519")}" >> got.txt 2>&1\necho "exit $?" >> got.txt`);
      const gate = field === "testCommand" ? testRunGate : buildGate;

      await gate(runner, NOT_NPM, TIMEOUT_MS, own({ [field]: "./steal.sh" })).run(context);

      const got = readFileSync(join(worktree, "got.txt"), "utf8");
      expect(got).toContain("readable");
      expect(got).not.toContain("fake-secret-bp985");
      expect(got).toContain("exit 1");
    });

    // Seatbelt matches paths, so a hard link would be a second, allowed path to the same file. What
    // stops one is that the home is not writable, and this holds that in place
    it("refuses a hard link to a file in the real home", async () => {
      script("link.sh", `ln "${join(canary, "id_ed25519")}" linked 2> error.txt; echo "exit $?" >> error.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./link.sh" })).run(context);

      expect(existsSync(join(worktree, "linked"))).toBe(false);
      expect(readFileSync(join(worktree, "error.txt"), "utf8")).toContain("Operation not permitted");
    });

    it("refuses a listing of the real home", async () => {
      script("list.sh", `ls "${canary}" > listed.txt 2> error.txt; echo "exit $?" >> error.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./list.sh" })).run(context);

      expect(readFileSync(join(worktree, "listed.txt"), "utf8")).toBe("");
      expect(readFileSync(join(worktree, "error.txt"), "utf8")).toContain("Operation not permitted");
    });

    it("refuses a socket in the real home, which is where a password manager's agent listens, and not one elsewhere", async () => {
      const inHome = join(canary, "agent.sock");
      const elsewhere = join(root, "s.sock");
      const servers = [inHome, elsewhere].map((path) => createNetServer((socket) => socket.end()).listen(path));
      await Promise.all(servers.map((server) => new Promise((done) => server.once("listening", done))));
      const connect = (path: string) => `require('net').connect('${path}').on('connect', () => { console.log('reached'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); })`;
      script("sockets.sh", `"${process.execPath}" -e "${connect(inHome)}" > home.txt\n"${process.execPath}" -e "${connect(elsewhere)}" > elsewhere.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./sockets.sh" })).run(context);
      servers.forEach((server) => server.close());

      expect(readFileSync(join(worktree, "home.txt"), "utf8")).toContain("EPERM");
      expect(readFileSync(join(worktree, "elsewhere.txt"), "utf8")).toContain("reached");
    });

    it("refuses the socket launchd gives an ssh agent", () => {
      const spawn = confine("/usr/bin/true", [], { writable: [worktree], sealedHomes: { homes: ["/Users/x"], readable: [] } });

      expect(JSON.stringify(spawn)).toContain("com\\\\.apple\\\\.launchd");
    });

    it("keeps git working in a linked worktree, whose clone is under the home it cannot read", async () => {
      const clone = realpathSync(mkdtempSync(join(homedir(), ".bp985-clone-")));
      try {
        const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", ...args], { cwd: clone, stdio: "pipe" });
        git("init", "-q", "-b", "main");
        git("commit", "-q", "--allow-empty", "-m", "first");
        const linked = join(clone, "linked");
        git("worktree", "add", "-q", linked);
        writeFileSync(join(linked, "gitcheck.sh"), `git rev-parse HEAD > head.txt\n`);

        const verdict = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "sh gitcheck.sh" })).run({
          ...context,
          worktreePath: linked,
          worktreeDir: recordDir(linked),
          checkoutGitDir: join(clone, ".git"),
        });

        expect(verdict).toMatchObject({ ok: true });
        expect(readFileSync(join(linked, "head.txt"), "utf8")).toMatch(/^[0-9a-f]{40}/);
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
    });

    it("keeps a verdict when the command leaves its temp directory undeletable", async () => {
      script("locked.sh", `mkdir "$TMPDIR/locked" && touch "$TMPDIR/locked/file" && /usr/bin/chflags uchg "$TMPDIR/locked/file"`);

      const verdict = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./locked.sh" })).run(context);

      expect(verdict).toMatchObject({ ok: true });
    });
  });
});
