import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../exec.js";
import { claimedTask } from "../__fixtures__/task.js";
import { recordDir } from "../sandbox.js";
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

describe.skipIf(!onMac)("a project's own gate commands against the real sandbox", { timeout: TIMEOUT_MS }, () => {
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

    // Seatbelt matches paths, so a hard link would be a second, allowed path to the same file
    it("refuses a hard link to a file in the real home", async () => {
      script("link.sh", `ln "${join(canary, "id_ed25519")}" linked 2> error.txt; echo "exit $?" >> error.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./link.sh" })).run(context);

      expect(existsSync(join(worktree, "linked"))).toBe(false);
      expect(readFileSync(join(worktree, "error.txt"), "utf8")).toContain("No such file or directory");
    });

    it("answers node's recursive mkdir in the real home, which an ENOENT there would send round for ever", async () => {
      const made = [canary, join(canary, "new"), join(canary, "new", "deep")].map((dir) => `try { fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true }); console.log('made') } catch (e) { console.log(e.code) }`);
      writeFileSync(join(worktree, "mkdirs.js"), `const fs = require("fs");\n${made.join("\n")}\n`);
      script("mkdirs.sh", `"${process.execPath}" mkdirs.js > made.txt`);

      const verdict = await testRunGate(runner, NOT_NPM, 5_000, own({ testCommand: "./mkdirs.sh" })).run(context);

      expect(verdict).toMatchObject({ ok: true });
      expect(readFileSync(join(worktree, "made.txt"), "utf8")).toBe("ENOENT\nEPERM\nEPERM\n");
      expect(existsSync(join(canary, "new"))).toBe(false);
    });

    it("confirms a guessed name in the real home and says nothing else about it", async () => {
      const key = join(canary, "id_ed25519");
      writeFileSync(join(worktree, "probe.js"), `const fs = require("fs");\nconsole.log(fs.existsSync(${JSON.stringify(key)}));\ntry { fs.statSync(${JSON.stringify(key)}) } catch (e) { console.log(e.code) }\n`);
      script("probe.sh", `"${process.execPath}" probe.js > found.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./probe.sh" })).run(context);

      expect(readFileSync(join(worktree, "found.txt"), "utf8")).toBe("true\nENOENT\n");
    });

    it("refuses a listing of the real home", async () => {
      script("list.sh", `ls "${canary}" > listed.txt 2> error.txt; echo "exit $?" >> error.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./list.sh" })).run(context);

      expect(readFileSync(join(worktree, "listed.txt"), "utf8")).toBe("");
      expect(readFileSync(join(worktree, "error.txt"), "utf8")).toContain("No such file or directory");
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

    // yarn opens a `.yarnrc` in every parent with no `stat` first, and stops on anything but ENOENT
    it("shows a tool walking up from a worktree under the home nothing there, and leaves that worktree's socket alone", async () => {
      const inHome = join(canary, "proj", "wt");
      mkdirSync(inHome, { recursive: true });
      mkdirSync(`${inHome}.home`);
      writeFileSync(join(canary, ".npmrc"), "fake-secret-bp985\n");
      writeFileSync(join(inHome, "walk.cjs"), `
const fs = require("fs"), net = require("net"), path = require("path");
const answer = (look) => { try { look(); return "answered"; } catch (error) { return error.code; } };
const above = path.dirname(path.dirname(process.cwd()));
const socket = path.join(process.cwd(), "s.sock");
const saw = {
  absent: answer(() => fs.readFileSync(path.join(above, ".yarnrc"))),
  planted: answer(() => fs.readFileSync(path.join(above, ".npmrc"))),
  stat: answer(() => fs.statSync(path.join(above, ".npmrc"))),
  parent: answer(() => fs.statSync(above)),
};
net.createServer((s) => s.end()).listen(socket, () => net.connect(socket)
  .on("connect", () => { saw.socket = "reached"; fs.writeFileSync("saw.json", JSON.stringify(saw)); process.exit(0); })
  .on("error", (error) => { saw.socket = error.code; fs.writeFileSync("saw.json", JSON.stringify(saw)); process.exit(0); }));
`);
      writeFileSync(join(inHome, "walk.sh"), `#!/bin/sh\nexec "${process.execPath}" walk.cjs\n`);
      chmodSync(join(inHome, "walk.sh"), 0o755);
      const underTheHome = { ...context, worktreePath: inHome, worktreeDir: recordDir(inHome), gateHome: recordDir(`${inHome}.home`), checkoutGitDir: join(inHome, ".git") };

      const verdict = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./walk.sh" })).run(underTheHome);

      expect(verdict).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(join(inHome, "saw.json"), "utf8"))).toEqual({ absent: "ENOENT", planted: "ENOENT", stat: "ENOENT", parent: "answered", socket: "reached" });
    });

    it("refuses the socket launchd gives an ssh agent", async () => {
      const directory = `/private/tmp/com.apple.launchd.bp985-${process.pid}`;
      mkdirSync(directory);
      try {
        const socket = join(directory, "Listeners");
        const server = createNetServer((peer) => peer.end()).listen(socket);
        await new Promise((done) => server.once("listening", done));
        const connect = `require('net').connect('${socket}').on('connect', () => { console.log('reached'); process.exit(0); }).on('error', (e) => { console.log(e.code); process.exit(0); })`;
        script("agent.sh", `"${process.execPath}" -e "${connect}" > agent.txt 2>&1`);

        await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./agent.sh" })).run(context);
        server.close();

        expect(readFileSync(join(worktree, "agent.txt"), "utf8")).toContain("EPERM");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("refuses the keychain's daemon", async () => {
      script("keychain.sh", `/usr/bin/security show-keychain-info /Library/Keychains/System.keychain > keychain.txt 2>&1; echo "exit $?" >> keychain.txt`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./keychain.sh" })).run(context);

      expect(readFileSync(join(worktree, "keychain.txt"), "utf8")).not.toContain("exit 0");
    });

    it("shuts a HOME that is not the account's, and the account's while HOME names another", async () => {
      const other = realpathSync(mkdtempSync(join(tmpdir(), "bp985-home-")));
      writeFileSync(join(other, "id_ed25519"), "fake-secret-bp985\n");
      vi.stubEnv("HOME", other);
      script("steal.sh", `cat "${join(other, "id_ed25519")}" "${join(canary, "id_ed25519")}" > got.txt 2>&1; true`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./steal.sh" })).run(context);
      rmSync(other, { recursive: true, force: true });

      expect(readFileSync(join(worktree, "got.txt"), "utf8")).not.toContain("fake-secret-bp985");
    });

    it("does not open the home for a PATH entry of /", async () => {
      vi.stubEnv("PATH", "/:/usr/bin:/bin");
      script("steal.sh", `cat "${join(canary, "id_ed25519")}" > got.txt 2>&1; true`);

      await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./steal.sh" })).run(context);

      expect(readFileSync(join(worktree, "got.txt"), "utf8")).not.toContain("fake-secret-bp985");
    });

    function underTheHome() {
      const inHome = join(canary, "cp-worktrees", "wt");
      mkdirSync(inHome, { recursive: true });
      mkdirSync(`${inHome}.home`);
      const at = { ...context, worktreePath: inHome, worktreeDir: recordDir(inHome), gateHome: recordDir(`${inHome}.home`), checkoutGitDir: join(inHome, ".git") };
      return { inHome, at };
    }

    it("reads back what an install left when the worktree root is under the home, as on a real machine", async () => {
      const { inHome, at } = underTheHome();
      writeFileSync(join(inHome, "install.sh"), '#!/bin/sh\nmkdir -p "$HOME/deps" && echo fetched > "$HOME/deps/module"\n');
      writeFileSync(join(inHome, "check.sh"), '#!/bin/sh\ntest "$(cat "$HOME/deps/module")" = fetched\n');
      chmodSync(join(inHome, "install.sh"), 0o755);
      chmodSync(join(inHome, "check.sh"), 0o755);

      const verdict = await buildGate(runner, NOT_NPM, TIMEOUT_MS, own({ installCommand: "./install.sh", buildCommand: "./check.sh" })).run(at);

      expect(verdict).toMatchObject({ ok: true });
    });

    it("runs a program on PATH that is a link into the home, and reads the lib beside a bin there", async () => {
      mkdirSync(join(canary, "tool", "bin"), { recursive: true });
      mkdirSync(join(canary, "tool", "lib"));
      writeFileSync(join(canary, "tool", "lib", "module"), "code\n");
      writeFileSync(join(canary, "tool", "bin", "tool"), `#!/bin/sh\ncat "${join(canary, "tool", "lib", "module")}"\n`);
      chmodSync(join(canary, "tool", "bin", "tool"), 0o755);
      writeFileSync(join(canary, "tool", "bin", "plain"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(canary, "tool", "bin", "plain"), 0o755);
      mkdirSync(join(root, "bin"));
      symlinkSync(join(canary, "tool", "bin", "plain"), join(root, "bin", "linked"));

      vi.stubEnv("PATH", `${join(canary, "tool", "bin")}:/usr/bin:/bin`);
      expect(await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "tool" })).run(context)).toMatchObject({ ok: true });

      vi.stubEnv("PATH", `${join(root, "bin")}:/usr/bin:/bin`);
      expect(await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "linked" })).run(context)).toMatchObject({ ok: true });
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
