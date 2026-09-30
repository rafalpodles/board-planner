import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunner, Runner } from "./exec.js";
import {
  compilerDefine,
  createReaper,
  approvedByUser,
  quarantineOf,
  markConfinedSpawn,
  newMarker,
  Reaper,
  REAPER_SOURCE,
  REAPER_SOURCE_HASH,
  ReapOutcome,
  untamperable,
  workerMarkFor,
  writableIn,
} from "./reap.js";
import { confine, SANDBOX_COMMAND } from "./sandbox.js";

const onMac = process.platform === "darwin";

function sizes(dir: string): Record<string, number> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).size]));
}

function writerLoop(file: string): string {
  return `while :; do echo x >> '${file}'; sleep 0.05; done`;
}

// Four ways out of a process group, each announcing itself by writing before the step exits
function backgroundingStep(dir: string): string {
  const perlDaemon = (body: string) =>
    `/usr/bin/perl -e 'use POSIX; exit if fork; POSIX::setsid(); exit if fork; open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">&STDOUT"; ${body}'`;
  return [
    perlDaemon(`while (1) { open F, ">>${dir}/setsid"; print F "x\\n"; close F; select(undef, undef, undef, 0.05) }`),
    perlDaemon(`while (1) { my $p = fork; if (!$p) { open F, ">>${dir}/respawn"; print F "x\\n"; close F; select(undef, undef, undef, 0.05); exit } select(undef, undef, undef, 0.01) }`),
    `nohup sh -c "${writerLoop(`${dir}/nohup`)}" >/dev/null 2>&1 &`,
    `(sh -c "${writerLoop(`${dir}/disowned`)}" >/dev/null 2>&1 &)`,
    `for f in setsid respawn nohup disowned; do while [ ! -s "${dir}/$f" ]; do sleep 0.02; done; done`,
  ].join("\n");
}

describe.skipIf(!onMac)("a confined spawn leaves nothing running behind it", () => {
  let dir: string;
  let worktree: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp796-"));
    worktree = join(dir, "worktree");
    mkdirSync(worktree);
  });

  afterEach(() => {
    // A red run leaves the writers alive, and the next run's CI would inherit them
    spawnSync("/usr/bin/pkill", ["-9", "-f", dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  function confinedSh(runner: Runner, script: string, timeoutMs = 30_000) {
    const spawned = confine("/bin/sh", ["-c", script], { writable: [worktree], env: {} });
    if (!("command" in spawned)) throw new Error(`refused: ${spawned.refusal}`);
    return runner.run(spawned.command, spawned.args, { cwd: worktree, timeoutMs });
  }

  async function expectNothingWritten(): Promise<void> {
    const before = sizes(worktree);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(sizes(worktree)).toEqual(before);
  }

  it("kills a setsid daemon, a respawning one, a nohup job and a disowned one when the step exits", async () => {
    const result = await confinedSh(createRunner(), backgroundingStep(worktree));

    expect(result.code).toBe(0);
    expect(result.machineFault).toBeUndefined();
    expect(Object.keys(sizes(worktree)).sort()).toEqual(["disowned", "nohup", "respawn", "setsid"]);
    await expectNothingWritten();
  }, 30_000);

  it("kills them when the step times out", async () => {
    const result = await confinedSh(createRunner(), `${backgroundingStep(worktree)}\nsleep 60`, 3000);

    expect(result.timedOut).toBe(true);
    expect(result.machineFault).toBeUndefined();
    await expectNothingWritten();
  }, 30_000);

  // A worker that crashed, was killed or was restarted never ran its per-spawn reap, and its
  // markers died with it. What the next process can still name is the worker's own mark.
  it("kills what a previous process of the same worker left, and nothing of another worker's", async () => {
    const stateDir = join(dir, "state");
    const neverReaps: Reaper = { ready: async () => "", reap: async () => ({ ok: true, killed: 0 }) };
    const crashed = createRunner({ reaper: neverReaps });
    expect(await crashed.reapLeftovers?.(stateDir)).toBe("");
    await confinedSh(crashed, backgroundingStep(worktree));

    const anotherWorker = createRunner();
    expect(await anotherWorker.reapLeftovers?.(join(dir, "other-state"))).toBe("");
    const before = sizes(worktree);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const [name, size] of Object.entries(sizes(worktree))) expect(size).toBeGreaterThan(before[name]);

    expect(await createRunner().reapLeftovers?.(stateDir)).toBe("");
    await expectNothingWritten();
  }, 30_000);

  it("leaves another spawn's processes alone", async () => {
    const other = markConfinedSpawn(["-p", "(version 1)\n(allow default)", "/bin/sh", "-c", "echo ready; exec /bin/sleep 60"]);
    if ("refusal" in other) throw new Error(other.refusal);
    const sibling = spawn(SANDBOX_COMMAND, other.args, { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise((resolve) => sibling.stdout.once("data", resolve));

      await confinedSh(createRunner(), "true");

      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      const reaped = await createReaper().reap(other.marker);
      expect(reaped).toEqual({ ok: true, killed: 1 });
    } finally {
      sibling.kill("SIGKILL");
    }
  }, 30_000);
});

describe("when a confined spawn cannot be reaped", () => {
  function reaperAnswering(...outcomes: ReapOutcome[]): Reaper & { reap: ReturnType<typeof vi.fn> } {
    const reap = vi.fn(async () => outcomes.shift() ?? { ok: true as const, killed: 0 });
    return { ready: async () => "", reap };
  }

  it("marks the result as the machine's fault", async () => {
    const reaper = reaperAnswering({ ok: false, reason: "cannot kill process 42: Operation not permitted" });
    const result = await createRunner({ reaper }).run(SANDBOX_COMMAND, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], {
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });

    expect(result.machineFault).toContain("cannot kill process 42");
  });

  it("refuses the next confined spawn until the survivor is gone", async () => {
    const reaper = reaperAnswering(
      { ok: false, reason: "processes kept appearing" },
      { ok: false, reason: "processes kept appearing" },
      { ok: true, killed: 3 }
    );
    const runner = createRunner({ reaper });
    const dir = mkdtempSync(join(tmpdir(), "bp796-latch-"));
    const ran = join(dir, "ran");
    const args = ["-p", "(version 1)\n(allow default)", "/usr/bin/touch", ran];
    try {
      await runner.run(SANDBOX_COMMAND, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { cwd: dir, timeoutMs: 10_000 });

      const refused = await runner.run(SANDBOX_COMMAND, args, { cwd: dir, timeoutMs: 10_000 });
      expect(refused.machineFault).toContain("processes kept appearing");
      expect(existsSync(ran)).toBe(false);

      const recovered = await runner.run(SANDBOX_COMMAND, args, { cwd: dir, timeoutMs: 10_000 });
      expect(recovered.machineFault).toBeUndefined();
      expect(existsSync(ran)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the spawn when the helper cannot be built, rather than running it unreaped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bp796-unbuilt-"));
    const ran = join(dir, "ran");
    try {
      const runner = createRunner({ reaper: createReaper({ compiler: "/usr/bin/false", bundled: join(dir, "absent") }) });
      const result = await runner.run(SANDBOX_COMMAND, ["-p", "(version 1)\n(allow default)", "/usr/bin/touch", ran], {
        cwd: dir,
        timeoutMs: 10_000,
      });

      expect(result.machineFault).toContain("could not build the process reaper with /usr/bin/false");
      expect(existsSync(ran)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never asks the reaper about an unconfined command", async () => {
    const reaper = reaperAnswering();
    await createRunner({ reaper }).run("/usr/bin/true", [], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(reaper.reap).not.toHaveBeenCalled();
  });
});

const APPROVED = "01c1;69d8c4bc;Chrome;7BC92DB3-3762-466F-A7F3-E7DD05CD70E8";
const UNAPPROVED = "0083;69d8c4bc;Chrome;7BC92DB3-3762-466F-A7F3-E7DD05CD70E8";

describe.skipIf(!onMac)("the helper it trusts", () => {
  let dir: string;
  let helper: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp796-helper-"));
    mkdirSync(join(dir, "bin"));
    const source = join(dir, "reap.c");
    writeFileSync(source, REAPER_SOURCE);
    helper = join(dir, "bin", "cp-reap");
    const built = spawnSync("/usr/bin/cc", ["-O2", compilerDefine(), source, "-o", helper]);
    if (built.status !== 0) throw new Error(String(built.stderr));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a prebuilt helper without a compiler, once it has killed its probe", async () => {
    expect(await createReaper({ compiler: "/nonexistent/cc", bundled: helper }).ready([])).toBe("");
  });

  it("refuses a confined spawn whose writable paths reach the helper", async () => {
    const reaper = createReaper({ compiler: "/nonexistent/cc", bundled: helper });

    expect(await reaper.ready([join(dir, "elsewhere")])).toBe("");
    expect(await reaper.ready([dir])).toContain("could rewrite the process reaper");
    expect(await reaper.ready([join(dir, "bin")])).toContain("could rewrite the process reaper");
  });

  it("refuses, through the runner, to run a spawn allowed to write where the helper is", async () => {
    const runner = createRunner({ reaper: createReaper({ compiler: "/nonexistent/cc", bundled: helper }) });
    const ran = join(dir, "ran");
    const spawned = confine("/usr/bin/touch", [ran], { writable: [dir], env: {} });
    if (!("command" in spawned)) throw new Error(spawned.refusal);

    const result = await runner.run(spawned.command, spawned.args, { cwd: dir, timeoutMs: 10_000 });

    expect(result.machineFault).toContain("could rewrite the process reaper");
    expect(existsSync(ran)).toBe(false);
  });

  it("refuses a helper, or a directory holding it, that others can write", async () => {
    chmodSync(helper, 0o775);
    expect(await createReaper({ compiler: "/nonexistent/cc", bundled: helper }).ready([])).toContain("writable by others");

    chmodSync(helper, 0o755);
    chmodSync(join(dir, "bin"), 0o777);
    expect(untamperable(helper)).toContain("writable by others");
  });

  // Stubbed rather than a real quarantined download, which would put a Gatekeeper prompt on this Mac
  function hangingHelper(): string {
    const stub = join(dir, "bin", "hangs");
    writeFileSync(stub, `#!/bin/sh\n# cp-reap-source:${REAPER_SOURCE_HASH}\nexec /bin/sleep 30\n`);
    chmodSync(stub, 0o755);
    return stub;
  }

  it("does not run a quarantined helper at all, and says how to release it", async () => {
    const ran = join(dir, "ran");
    const stub = join(dir, "bin", "quarantined");
    writeFileSync(stub, `#!/bin/sh\n# cp-reap-source:${REAPER_SOURCE_HASH}\ntouch '${ran}'\nexec /bin/sleep 30\n`);
    chmodSync(stub, 0o755);

    const failure = await createReaper({ compiler: "/nonexistent/cc", bundled: stub, quarantine: async () => UNAPPROVED }).ready([]);

    expect(failure).toContain("quarantined");
    expect(failure).toContain(`xattr -dr com.apple.quarantine ${dir}`);
    expect(existsSync(ran)).toBe(false);
  });

  it("names a helper that hangs within seconds, rather than waiting out a minute", async () => {
    const started = Date.now();
    const failure = await createReaper({
      compiler: "/nonexistent/cc",
      bundled: hangingHelper(),
      probeTimeoutMs: 300,
      quarantine: async () => null,
    }).ready([]);

    expect(failure).toContain("did not answer within 0.3s");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never offers to install the command-line tools when they are missing", async () => {
    const toolchain = vi.fn(async () => false);
    const failure = await createReaper({ bundled: join(dir, "absent"), toolchain }).ready([]);

    expect(toolchain).toHaveBeenCalled();
    expect(failure).toContain("no compiler to build one");
  });

  // On a data file that is never run, so nothing asks Gatekeeper about it. The value is one an
  // approved app in /Applications carries on every file inside it.
  it("reads a quarantine the user approved as approved, and one never approved as not", async () => {
    const file = join(dir, "downloaded.txt");
    writeFileSync(file, "data");
    expect(await quarantineOf(file)).toBeNull();

    spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", APPROVED, file]);
    const approved = await quarantineOf(file);
    expect(approved).toBe(APPROVED);
    expect(approvedByUser(approved ?? "")).toBe(true);

    spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", UNAPPROVED, file]);
    expect(approvedByUser((await quarantineOf(file)) ?? "")).toBe(false);
    expect(approvedByUser("not a quarantine value")).toBe(false);
  });

  it("runs a helper whose quarantine was approved", async () => {
    expect(await createReaper({ compiler: "/nonexistent/cc", bundled: helper, quarantine: async () => APPROVED }).ready([])).toBe("");
  });

  // Archive Utility leaves the attribute on every file of an unzipped app, approved or not
  it("runs a helper inside an app whose seal holds, whatever its quarantine says", async () => {
    const app = join(dir, "Probe.app");
    const bin = join(app, "Contents", "Resources", "worker", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(app, "Contents", "MacOS"));
    copyFileSync(helper, join(bin, "cp-reap"));
    copyFileSync(helper, join(app, "Contents", "MacOS", "Probe"));
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Probe</string><key>CFBundleIdentifier</key><string>com.boardplanner.bp796.probe</string></dict></plist>'
    );
    for (const target of [join(bin, "cp-reap"), app]) {
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", target]);
      if (signed.status !== 0) throw new Error(String(signed.stderr));
    }
    const inApp = join(bin, "cp-reap");

    expect(await createReaper({ compiler: "/nonexistent/cc", bundled: inApp, quarantine: async () => UNAPPROVED }).ready([])).toBe("");

    writeFileSync(join(app, "Contents", "Resources", "planted"), "x");
    expect(await createReaper({ compiler: "/nonexistent/cc", bundled: inApp, quarantine: async () => UNAPPROVED }).ready([])).toContain(
      "never approved"
    );
  });

  it("builds one here instead when the bundled helper cannot be used, and warns which was used", async () => {
    const warn = vi.fn();
    const reaper = createReaper({ bundled: hangingHelper(), probeTimeoutMs: 300, quarantine: async () => null, warn });

    expect(await reaper.ready([])).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^warning: the bundled process reaper was not used \(the reaper did not answer within 0\.3s\); using one built with \/usr\/bin\/cc instead$/));
  });

  it("builds one here instead of a quarantined one, without running it", async () => {
    const warn = vi.fn();
    const reaper = createReaper({ bundled: hangingHelper(), quarantine: async () => UNAPPROVED, warn });

    expect(await reaper.ready([])).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("it is quarantined"));
  });

  it("does not use a helper built from other source than this worker's", async () => {
    const stale = join(dir, "bin", "stale");
    const built = spawnSync("/usr/bin/cc", ["-O2", '-DCP_REAP_SOURCE_HASH="0000000000000000"', join(dir, "reap.c"), "-o", stale]);
    if (built.status !== 0) throw new Error(String(built.stderr));

    const alone = await createReaper({ compiler: "/nonexistent/cc", bundled: stale, quarantine: async () => null }).ready([]);
    expect(alone).toContain("built from other source");
    const warn = vi.fn();
    expect(await createReaper({ bundled: stale, quarantine: async () => null, warn }).ready([])).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("built from other source"));
  });

  it("refuses a path that does not resolve to a file", () => {
    expect(untamperable(join(dir, "missing"))).toContain("cannot resolve");
    expect(untamperable(join(dir, "bin"))).toContain("not a regular file");
  });
});

describe("untamperable, on a Mac with more than one user", () => {
  const file = { uid: 0, mode: 0o100755, isFile: () => true, isDirectory: () => false };
  const directory = (uid: number, mode = 0o40755) => ({ uid, mode, isFile: () => false, isDirectory: () => true });

  function owned(helperOwner: number, mode = 0o100755) {
    return (path: string) =>
      path === "/Applications/CPMenubar.app/Contents/Resources/worker/bin/cp-reap"
        ? { ...file, uid: helperOwner, mode }
        : path.includes("CPMenubar.app")
          ? directory(helperOwner)
          : path === "/Applications"
            ? directory(0, 0o40775)
            : directory(0);
  }
  const at = { realpath: (path: string) => path };
  const helper = "/Applications/CPMenubar.app/Contents/Resources/worker/bin/cp-reap";

  it("trusts a helper owned by whoever owns the worker's own code", () => {
    expect(untamperable(helper, { ...at, uid: 502, codeOwner: 501, lstat: owned(501) })).toBe("");
  });

  it("refuses one owned by anybody else", () => {
    expect(untamperable(helper, { ...at, uid: 502, codeOwner: 503, lstat: owned(501) })).toContain("belongs to a user");
  });

  it("still refuses one its owner left writable by others", () => {
    expect(untamperable(helper, { ...at, uid: 502, codeOwner: 501, lstat: owned(501, 0o100775) })).toContain("writable by others");
  });
});

describe("markConfinedSpawn", () => {
  it("gives a state directory the same mark before it exists as after", () => {
    const base = mkdtempSync(join(tmpdir(), "bp796-state-"));
    try {
      const stateDir = join(base, "not", "yet");
      const before = workerMarkFor(stateDir);
      mkdirSync(stateDir, { recursive: true });
      expect(workerMarkFor(stateDir)).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("adds this worker's mark too, once the worker has one", () => {
    const marker = newMarker();
    const worker = workerMarkFor("/state/a");
    const marked = markConfinedSpawn(["-p", "(version 1)", "/bin/sh"], marker, worker);

    expect(marked).toEqual({
      args: [
        "-p",
        '(version 1)\n(deny mach-lookup (global-name (param "CP_SPAWN_MARK")))\n(deny mach-lookup (global-name (param "CP_WORKER_MARK")))',
        "-D",
        `CP_SPAWN_MARK=${marker.denied}`,
        "-D",
        `CP_WORKER_MARK=${worker.denied}`,
        "/bin/sh",
      ],
      marker,
    });
  });

  it("names a worker by its state directory: the same one twice, two different ones apart", () => {
    expect(workerMarkFor("/state/a")).toEqual(workerMarkFor("/state/a"));
    expect(workerMarkFor("/state/a").denied).not.toBe(workerMarkFor("/state/b").denied);
  });

  it("reads the writable paths out of a sandbox-exec argument list", () => {
    expect(writableIn(["-p", "(version 1)", "-D", "W0=/wt", "-D", "W1=/tmp/x", "-D", "CP_SPAWN_MARK=com.x", "/bin/sh"])).toEqual(["/wt", "/tmp/x"]);
  });

  it("adds the spawn's own deny rule and parameter to the inline profile", () => {
    const marker = newMarker();
    const marked = markConfinedSpawn(["-p", "(version 1)", "-D", "W0=/x", "/bin/sh"], marker);

    expect(marked).toEqual({
      args: ["-p", '(version 1)\n(deny mach-lookup (global-name (param "CP_SPAWN_MARK")))', "-D", `CP_SPAWN_MARK=${marker.denied}`, "-D", "W0=/x", "/bin/sh"],
      marker,
    });
  });

  it("refuses a sandbox-exec spawn it cannot mark", () => {
    expect(markConfinedSpawn(["-f", "profile.sb", "/bin/sh"])).toHaveProperty("refusal");
  });

  it("gives every spawn a name of its own", () => {
    expect(newMarker().denied).not.toBe(newMarker().denied);
  });
});
