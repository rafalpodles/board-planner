import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../exec.js";
import { INSTALL_NETWORK_OPT_IN } from "../env.js";
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

describe.skipIf(!onMac)("a project's own gate commands against the real sandbox", () => {
  let root = "";
  let worktree = "";
  let outside = "";
  let context: GateContext;
  let listener: Server;
  let port = 0;
  const runner = createRunner();

  function script(name: string, body: string) {
    writeFileSync(join(worktree, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(worktree, name), 0o755);
  }

  const own = (commands: Partial<GateCommands>) => gateCommandsOf(commands);

  beforeAll(async () => {
    listener = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    port = (listener.address() as AddressInfo).port;
  });

  afterAll(() => {
    listener.close();
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bp985-int-")));
    worktree = join(root, "wt");
    outside = join(root, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    mkdirSync(join(root, "wt.home"));
    vi.stubEnv(INSTALL_NETWORK_OPT_IN, "");
    context = {
      worktreePath: worktree,
      worktreeDir: recordDir(worktree),
      gateHome: recordDir(join(root, "wt.home")),
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

  describe("the network", () => {
    // TEST-NET-1: never routed, so an open network times out where a closed one answers EPERM at once
    const SEND_OFF_MACHINE = `require('net').connect({ host: '192.0.2.1', port: 443, timeout: 2000 }).on('connect', () => process.exit(0)).on('timeout', () => { console.error('open'); process.exit(0); }).on('error', (e) => { console.error(e.code); process.exit(1); })`;
    const fetchOut = (name: string) => script(name, `exec "${process.execPath}" -e "${SEND_OFF_MACHINE}"`);

    it("is refused to a custom install by default, and the reason says who can open it", async () => {
      fetchOut("install.sh");

      const verdict = await buildGate(runner, NOT_NPM, TIMEOUT_MS, own({ installCommand: "./install.sh" })).run(context);

      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("EPERM");
      expect(verdict.reason).toContain(`${INSTALL_NETWORK_OPT_IN}=1`);
    });

    it("is open to a custom install once this machine's operator said so", async () => {
      vi.stubEnv(INSTALL_NETWORK_OPT_IN, "1");
      fetchOut("install.sh");

      const verdict = await buildGate(runner, NOT_NPM, TIMEOUT_MS, own({ installCommand: "./install.sh" })).run(context);

      expect(verdict).toMatchObject({ ok: true });
    });

    it("stays refused to a build and a test on a machine that opened it for the install", async () => {
      vi.stubEnv(INSTALL_NETWORK_OPT_IN, "1");
      fetchOut("step.sh");

      const built = await buildGate(runner, NOT_NPM, TIMEOUT_MS, own({ buildCommand: "./step.sh" })).run(context);
      const tested = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./step.sh" })).run(context);

      expect(built.reason).toContain("EPERM");
      expect(tested.reason).toContain("EPERM");
    });

    it("still reaches this machine, which a suite's own server needs", async () => {
      script("local.sh", `exec "${process.execPath}" -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"`);

      const verdict = await testRunGate(runner, NOT_NPM, TIMEOUT_MS, own({ testCommand: "./local.sh" })).run(context);

      expect(verdict).toMatchObject({ ok: true });
    });
  });
});
