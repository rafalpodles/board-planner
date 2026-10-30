import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandResult, Runner } from "../exec.js";
import { INSTALL_NETWORK_OPT_IN, UNCONFINED_ESCAPE_HATCH } from "../env.js";
import { claimedTask } from "../__fixtures__/task.js";
import { recordDir, SANDBOX_COMMAND } from "../sandbox.js";
import { GateContext } from "../types.js";
import { buildGate } from "./build.js";
import { gateCommandsOf, GateCommands, gateDirectory, resolveGateProgram, usesOwnCommands } from "./gate-commands.js";
import { testRunGate } from "./test-run.js";

const TIMEOUT_MS = 5000;
const NPM = "/opt/homebrew/bin/npm";
const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };

let root = "";
let worktree = "";
let context: GateContext;

function commands(own: Partial<GateCommands>): GateCommands {
  return gateCommandsOf(own);
}

function recording(result: CommandResult = ok) {
  const run = vi.fn<Runner["run"]>(async () => result);
  return { run, runner: { run } as Runner };
}

const profileOf = (args: string[]) => args.join("\n");
const lastWords = (args: string[], count: number) => args.slice(-count);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bp985-")));
  worktree = join(root, "wt");
  mkdirSync(worktree);
  mkdirSync(join(root, "wt.home"));
  context = {
    worktreePath: worktree,
    worktreeDir: recordDir(worktree),
    gateHome: recordDir(join(root, "wt.home")),
    task: claimedTask({ title: "t", description: "d" }),
    result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
    diff: { changedLines: 1, changedFiles: ["a.py"], patch: "", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", symlinks: [], suppressedDiffs: [], gitlinks: [] },
  };
  vi.stubEnv(UNCONFINED_ESCAPE_HATCH, "");
  vi.stubEnv(INSTALL_NETWORK_OPT_IN, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const describeOnMac = describe.skipIf(process.platform !== "darwin");

describeOnMac("the Builds gate on a project's own commands", () => {
  it("runs install then build as argv with no shell, confined, with the run's home and no npm", async () => {
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh -e install.sh", buildCommand: "sh build.sh --release" })).run(context);

    expect(verdict).toEqual({ ok: true, reason: "", commands: ["sh -e install.sh", "sh build.sh --release"] });
    expect(run).toHaveBeenCalledTimes(2);
    const [[command, install, options], [, build]] = run.mock.calls;
    expect(command).toBe(SANDBOX_COMMAND);
    expect(lastWords(install, 3)).toEqual(["/bin/sh", "-e", "install.sh"]);
    expect(lastWords(build, 3)).toEqual(["/bin/sh", "build.sh", "--release"]);
    expect(options?.env?.HOME).toBe(context.gateHome.path);
    expect(options?.env?.TMPDIR).not.toBe(context.gateHome.path);
    expect(options?.env).not.toHaveProperty("npm_config_cache");
    expect(profileOf(install)).toContain(context.gateHome.path);
  });

  it("gives the install no network unless this machine's operator said so, and the build none either way", async () => {
    const { run, runner } = recording();
    const gate = buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b" }));

    await gate.run(context);
    expect(profileOf(run.mock.calls[0][1])).toContain("(deny network-outbound)");
    expect(profileOf(run.mock.calls[1][1])).toContain("(deny network-outbound)");

    run.mockClear();
    vi.stubEnv(INSTALL_NETWORK_OPT_IN, "1");
    await gate.run(context);
    expect(profileOf(run.mock.calls[0][1])).not.toContain("(deny network-outbound)\n");
    expect(profileOf(run.mock.calls[1][1])).toContain("(deny network-outbound)");
  });

  it("says what to set when an install fails with no network, and does not blame a build for it", async () => {
    const { runner } = recording({ ...ok, code: 1, stderr: "connect EPERM" });

    const install = await buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh i" })).run(context);
    const build = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run(context);

    expect(install.reason).toContain(`${INSTALL_NETWORK_OPT_IN}=1`);
    expect(build.reason).not.toContain(INSTALL_NETWORK_OPT_IN);
  });

  it("stops at a failing install, and at a build that fails names the build", async () => {
    const { run, runner } = recording({ ...ok, code: 3, stdout: "boom" });

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b" })).run(context);

    expect(run).toHaveBeenCalledTimes(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/the install command failed \(exit 3/);
    expect(verdict.reason).toContain("boom");
  });

  it("refuses, naming the setting, when only a test command is set: it must not pass having judged nothing", async () => {
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("Settings → Workers");
    expect(verdict.machineFault).toBeUndefined();
  });

  it("names the program a command wanted when this machine does not have it", async () => {
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "no-such-tool-bp985 all" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ ok: false, reason: "build command: no-such-tool-bp985 was not found on this machine" });
  });

  it("runs in the working directory, and says so in what it ran", async () => {
    mkdirSync(join(worktree, "services", "api"), { recursive: true });
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b", workingDirectory: "services/api" })).run(context);

    expect(run.mock.calls[0][2]?.cwd).toBe(join(worktree, "services", "api"));
    expect(verdict.commands).toEqual(["sh b (in services/api)"]);
  });

  it("reports a home swapped under the gate as the run's doing, not the machine's", async () => {
    const { run, runner } = recording();
    rmSync(join(root, "wt.home"), { recursive: true });
    symlinkSync(tmpdir(), join(root, "wt.home"));

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    expect(verdict.tampered).toContain("wt.home");
    expect(verdict.machineFault).toBeUndefined();
  });
});

describeOnMac("the Tests gate on a project's own commands", () => {
  it("runs the test command with no network, and the home the install filled", async () => {
    const { run, runner } = recording();

    const verdict = await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t -v" })).run(context);

    expect(verdict).toEqual({ ok: true, reason: "", commands: ["sh t -v"] });
    expect(profileOf(run.mock.calls[0][1])).toContain("(deny network-outbound)");
    expect(run.mock.calls[0][2]?.env?.HOME).toBe(context.gateHome.path);
  });

  it("refuses, naming the setting, when other commands are set and this one is not", async () => {
    const { run, runner } = recording();

    const verdict = await testRunGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("Settings → Workers");
  });
});

describeOnMac("npm in a working directory", () => {
  it("keeps npm, in that directory, when only the directory is set", async () => {
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    const { run, runner } = recording();
    const onlyDirectory = commands({ workingDirectory: "apps/web" });

    const built = await buildGate(runner, NPM, TIMEOUT_MS, onlyDirectory).run(context);
    const tested = await testRunGate(runner, NPM, TIMEOUT_MS, onlyDirectory).run(context);

    expect(run.mock.calls.map(([, , options]) => options?.cwd)).toEqual(Array(3).fill(join(worktree, "apps", "web")));
    expect(usesOwnCommands(onlyDirectory)).toBe(false);
    expect(built.commands?.[1]).toBe("npm run build (in apps/web)");
    expect(tested.commands).toEqual(["npm test (in apps/web)"]);
  });
});

describe("gateDirectory", () => {
  it("is the checkout when no directory is set", () => {
    expect(gateDirectory(worktree, "")).toEqual({ path: worktree });
  });

  it("refuses a directory the checkout does not have", () => {
    expect(gateDirectory(worktree, "gone")).toEqual({ reason: "the working directory gone does not exist in this checkout" });
  });

  it("refuses a file", () => {
    writeFileSync(join(worktree, "file"), "");
    expect(gateDirectory(worktree, "file/below")).toEqual({ reason: "the working directory file/below is not a directory: file is a file" });
  });

  it("refuses a symlink anywhere along the path: an agent can plant one, and it would walk out of the worktree", () => {
    mkdirSync(join(worktree, "a"));
    symlinkSync(root, join(worktree, "a", "out"));
    mkdirSync(join(root, "below"));

    expect(gateDirectory(worktree, "a/out/below")).toEqual({ reason: "the working directory a/out/below passes through the symlink out" });
  });
});

describe("resolveGateProgram", () => {
  it("finds a bare name on the PATH and skips a relative entry, which would be the checkout", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
    chmodSync(join(bin, "tool"), 0o755);
    writeFileSync(join(worktree, "tool"), "#!/bin/sh\n");
    chmodSync(join(worktree, "tool"), 0o755);

    expect(resolveGateProgram("tool", worktree, `.:${bin}`)).toBe(join(bin, "tool"));
  });

  it("finds ./path in the directory the command runs in, and never on the PATH", () => {
    writeFileSync(join(worktree, "gradlew"), "#!/bin/sh\n");
    chmodSync(join(worktree, "gradlew"), 0o755);

    expect(resolveGateProgram("./gradlew", worktree, "")).toBe(join(worktree, "gradlew"));
    expect(resolveGateProgram("./missing", worktree, "/bin")).toBeNull();
  });

  it("does not take a file that cannot be executed, or a directory", () => {
    writeFileSync(join(worktree, "plain"), "");
    mkdirSync(join(worktree, "dir"));

    expect(resolveGateProgram("./plain", worktree, "")).toBeNull();
    expect(resolveGateProgram("./dir", worktree, "")).toBeNull();
  });
});
