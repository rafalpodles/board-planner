import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { CommandResult, Runner } from "../exec.js";
import { UNCONFINED_ESCAPE_HATCH } from "../env.js";
import { claimedTask } from "../__fixtures__/task.js";
import { recordDir, SANDBOX_COMMAND } from "../sandbox.js";
import { GateContext } from "../types.js";
import { buildGate } from "./build.js";
import { gateCommandsOf, GateCommands, gateConfigFault, gateDirectory, namedByGateCommand, resolveGateProgram, usesOwnCommands } from "./gate-commands.js";
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
    checkoutGitDir: join(root, "clone", ".git"),
    task: claimedTask({ title: "t", description: "d" }),
    result: { status: "completed", summary: "", filesChanged: [], testsAdded: [], blockedReason: "" },
    diff: { changedLines: 1, changedFiles: ["a.py"], patch: "", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", symlinks: [], suppressedDiffs: [], gitlinks: [] },
  };
  vi.stubEnv(UNCONFINED_ESCAPE_HATCH, "");
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
    expect(options?.env?.CFFIXED_USER_HOME).toBe(context.gateHome.path);
    expect(options?.env?.TMPDIR).toMatch(/\/cp-gate-[^/]+$/);
    expect(options?.env?.JAVA_TOOL_OPTIONS).toBe(`"-Djava.io.tmpdir=${options?.env?.TMPDIR}"`);
    expect(options?.env).not.toHaveProperty("npm_config_cache");
    expect(profileOf(install)).toContain(context.gateHome.path);
  });

  it("gives every command the network and seals the real home, the opposite of the npm gates", async () => {
    const { run, runner } = recording();

    await buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b" })).run(context);
    await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t" })).run(context);

    expect(run).toHaveBeenCalledTimes(3);
    for (const [, args] of run.mock.calls) {
      expect(profileOf(args)).not.toContain('(remote ip "localhost:*")');
      expect(profileOf(args)).toContain("(deny file-read-data");
      expect(profileOf(args)).toContain(`H0=${realpathSync(userInfo().homedir)}`);
      expect(profileOf(args)).toContain(`=${context.checkoutGitDir}`);
    }
  });

  it("does not reopen the home through a PATH entry that is the home itself", async () => {
    const home = realpathSync(userInfo().homedir);
    vi.stubEnv("PATH", `${home}:${dirname(home)}:/usr/bin:/bin`);
    const { run, runner } = recording();

    await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t" })).run(context);

    const opened = run.mock.calls[0][1].filter((arg) => /^R\d+=/.test(arg)).map((arg) => arg.slice(arg.indexOf("=") + 1));
    expect(opened).not.toContain(home);
    expect(opened).not.toContain(dirname(home));
  });

  it("stops at a failing install, saying so", async () => {
    const { run, runner } = recording({ ...ok, code: 3, stdout: "boom" });

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b" })).run(context);

    expect(run).toHaveBeenCalledTimes(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/the install command failed \(exit 3/);
    expect(verdict.reason).toContain("boom");
  });

  it("names the build when the build is what fails", async () => {
    const run = vi.fn<Runner["run"]>().mockResolvedValueOnce(ok).mockResolvedValueOnce({ ...ok, code: 2, stderr: "undefined: x" });

    const verdict = await buildGate({ run }, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b" })).run(context);

    expect(verdict.reason).toMatch(/the build command failed \(exit 2/);
    expect(verdict.reason).toContain("undefined: x");
  });

  it("gives the build what the install left of one budget, and refuses once none is left", async () => {
    const seen: (number | undefined)[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const run = vi.fn<Runner["run"]>(async (_command, _args, options) => {
      seen.push(options?.timeoutMs);
      now.mockReturnValue(1_000 + TIMEOUT_MS - 200);
      return ok;
    });
    const steps = commands({ installCommand: "sh i", buildCommand: "sh b" });

    await buildGate({ run }, NPM, TIMEOUT_MS, steps).run(context);
    expect(seen).toEqual([TIMEOUT_MS, 200]);

    now.mockReturnValue(1_000);
    run.mockImplementationOnce(async () => {
      now.mockReturnValue(1_000 + TIMEOUT_MS);
      return ok;
    });
    const spent = await buildGate({ run }, NPM, TIMEOUT_MS, steps).run(context);
    expect(spent).toMatchObject({ ok: false, reason: `the ${TIMEOUT_MS}ms budget ran out before the build command started` });
    now.mockRestore();
  });

  it("fails a command killed by a signal, which is no exit code to read as success", async () => {
    const { runner } = recording({ ...ok, code: -1 });

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run(context);

    expect(verdict.ok).toBe(false);
  });

  it("hands the run's abort signal to the command, so a stopped run does not wait out its timeout", async () => {
    const { run, runner } = recording();
    const controller = new AbortController();

    await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run({ ...context, signal: controller.signal });

    expect(run.mock.calls[0][2]?.signal).toBe(controller.signal);
  });

  it("finds a ./ program in the working directory, not at the root of the checkout", async () => {
    mkdirSync(join(worktree, "svc", "bin"), { recursive: true });
    writeFileSync(join(worktree, "svc", "bin", "test"), "#!/bin/sh\n");
    chmodSync(join(worktree, "svc", "bin", "test"), 0o755);
    const { run, runner } = recording();

    const verdict = await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "./bin/test", workingDirectory: "svc" })).run(context);

    expect(verdict.ok).toBe(true);
    expect(run.mock.calls[0][1]).toContain(join(worktree, "svc", "bin", "test"));
  });

  it("says a command timed out, rather than that it failed", async () => {
    const { runner } = recording({ ...ok, code: 1, timedOut: true });

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b" })).run(context);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^the build command timed out after \d+ms$/);
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
    expect(verdict).toMatchObject({ ok: false, reason: "build command: no-such-tool-bp985 was not found, or cannot be run" });
  });

  it("runs in the working directory, and says so in what it ran", async () => {
    mkdirSync(join(worktree, "services", "api"), { recursive: true });
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b", workingDirectory: "services/api" })).run(context);

    expect(run.mock.calls[0][2]?.cwd).toBe(join(worktree, "services", "api"));
    expect(verdict.commands).toEqual(["sh b (in services/api)"]);
  });

  it("refuses a working directory that is a symlink, running nothing", async () => {
    symlinkSync(root, join(worktree, "out"));
    const { run, runner } = recording();

    const verdict = await buildGate(runner, NPM, TIMEOUT_MS, commands({ buildCommand: "sh b", workingDirectory: "out" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ ok: false, reason: "the working directory out passes through the symlink out" });
  });

  it("judges the directory again before the build, since the install ran code that can have replaced it", async () => {
    const service = join(worktree, "svc");
    mkdirSync(service);
    const run = vi.fn<Runner["run"]>(async () => {
      rmSync(service, { recursive: true });
      symlinkSync(root, service);
      return ok;
    });

    const verdict = await buildGate({ run }, NPM, TIMEOUT_MS, commands({ installCommand: "sh i", buildCommand: "sh b", workingDirectory: "svc" })).run(context);

    expect(run).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ ok: false, reason: "the working directory svc passes through the symlink svc" });
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
  it("runs the test command with the home the install filled", async () => {
    const { run, runner } = recording();

    const verdict = await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t -v" })).run(context);

    expect(verdict).toEqual({ ok: true, reason: "", commands: ["sh t -v"] });
    expect(run.mock.calls[0][2]?.env?.HOME).toBe(context.gateHome.path);
  });

  it("refuses a working directory that is a symlink, running nothing", async () => {
    symlinkSync(root, join(worktree, "out"));
    const { run, runner } = recording();

    const verdict = await testRunGate(runner, NPM, TIMEOUT_MS, commands({ testCommand: "sh t", workingDirectory: "out" })).run(context);

    expect(run).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
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

describeOnMac("npm in a working directory that is a symlink", () => {
  it("is refused by both gates, running nothing", async () => {
    symlinkSync(root, join(worktree, "out"));
    const { run, runner } = recording();
    const onlyDirectory = commands({ workingDirectory: "out" });

    expect((await buildGate(runner, NPM, TIMEOUT_MS, onlyDirectory).run(context)).ok).toBe(false);
    expect((await testRunGate(runner, NPM, TIMEOUT_MS, onlyDirectory).run(context)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("gateConfigFault, read before anybody pays for a step", () => {
  const sequence = (...gateKinds: string[]) => gateKinds.map((gateKind) => ({ gateKind }));

  it("says nothing of a project on the npm gates", () => {
    expect(gateConfigFault(sequence("build", "test-run"), commands({}), worktree)).toBeNull();
  });

  it("names a gate the commands leave with nothing to run", () => {
    expect(gateConfigFault(sequence("build", "test-run"), commands({ testCommand: "sh t" }), worktree)).toMatch(/neither an install nor a build command/);
    expect(gateConfigFault(sequence("build", "test-run"), commands({ buildCommand: "sh b" }), worktree)).toMatch(/no test command/);
  });

  it("does not mind a gate the agent does not have", () => {
    expect(gateConfigFault(sequence("test-run"), commands({ testCommand: "sh t" }), worktree)).toBeNull();
  });

  it("names a ./ program the checkout does not have, or cannot run", () => {
    writeFileSync(join(worktree, "plain"), "");

    expect(gateConfigFault(sequence("test-run"), commands({ testCommand: "./gone" }), worktree)).toMatch(/\.\/gone/);
    expect(gateConfigFault(sequence("test-run"), commands({ testCommand: "./plain" }), worktree)).toMatch(/\.\/plain/);
  });

  it("leaves a working directory the checkout does not have yet to the gate: the task may create it", () => {
    expect(gateConfigFault(sequence("test-run"), commands({ testCommand: "./x", workingDirectory: "new" }), worktree)).toBeNull();
  });
});

describe("namedByGateCommand", () => {
  const named = commands({ testCommand: "./bin/test --fast", buildCommand: "python manage.py check", workingDirectory: "svc" });

  it("finds a program and a script in the working directory", () => {
    expect(namedByGateCommand("svc/bin/test", named)).toBe(true);
    expect(namedByGateCommand("svc/manage.py", named)).toBe(true);
  });

  it("finds a path after an equals sign or a short option, and the module of -m", () => {
    const options = commands({ testCommand: "make --file=ci/test.mk", buildCommand: "env RUN=ci/run.sh make -fother.mk", installCommand: "python3 -m ci.tests" });

    expect(namedByGateCommand("ci/test.mk", options)).toBe(true);
    expect(namedByGateCommand("ci/run.sh", options)).toBe(true);
    expect(namedByGateCommand("other.mk", options)).toBe(true);
    expect(namedByGateCommand("ci/tests.py", options)).toBe(true);
  });

  it("ignores case, because macOS will run bin/test for ./bin/Test", () => {
    expect(namedByGateCommand("bin/test", commands({ testCommand: "./bin/Test" }))).toBe(true);
    expect(namedByGateCommand("SVC/Check.sh", commands({ testCommand: "sh check.sh", workingDirectory: "svc" }))).toBe(true);
  });

  it("takes a word for a path only where it is one", () => {
    expect(namedByGateCommand("bin/test", named)).toBe(false);
    expect(namedByGateCommand("svc/check.py", named)).toBe(false);
    expect(namedByGateCommand("anything", commands({}))).toBe(false);
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
  it("finds a bare name on the PATH, never in the directory the command runs in", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
    chmodSync(join(bin, "tool"), 0o755);
    writeFileSync(join(worktree, "planted"), "#!/bin/sh\n");
    chmodSync(join(worktree, "planted"), 0o755);

    expect(resolveGateProgram("tool", worktree, bin)).toBe(join(bin, "tool"));
    expect(resolveGateProgram("planted", worktree, bin)).toBeNull();
  });

  it("finds ./path in the directory the command runs in, and never on the PATH", () => {
    writeFileSync(join(worktree, "gradlew"), "#!/bin/sh\n");
    chmodSync(join(worktree, "gradlew"), 0o755);

    expect(resolveGateProgram("./gradlew", worktree, "")).toBe(join(worktree, "gradlew"));
    expect(resolveGateProgram("./sh", worktree, "/bin")).toBeNull();
  });

  it("does not take a file that cannot be executed, or a directory", () => {
    writeFileSync(join(worktree, "plain"), "");
    mkdirSync(join(worktree, "dir"));

    expect(resolveGateProgram("./plain", worktree, "")).toBeNull();
    expect(resolveGateProgram("./dir", worktree, "")).toBeNull();
  });
});
