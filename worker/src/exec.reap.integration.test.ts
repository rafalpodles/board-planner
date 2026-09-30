import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunner, Runner } from "./exec.js";
import { createReaper, markConfinedSpawn, newMarker, Reaper, REAPER_SOURCE, ReapOutcome, untamperable, workerMarkFor, writableIn } from "./reap.js";
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
      const runner = createRunner({ reaper: createReaper({ compiler: "/nonexistent/cc" }) });
      const result = await runner.run(SANDBOX_COMMAND, ["-p", "(version 1)\n(allow default)", "/usr/bin/touch", ran], {
        cwd: dir,
        timeoutMs: 10_000,
      });

      expect(result.machineFault).toContain("could not build the process reaper with /nonexistent/cc");
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

describe.skipIf(!onMac)("the helper it trusts", () => {
  let dir: string;
  let helper: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp796-helper-"));
    mkdirSync(join(dir, "bin"));
    const source = join(dir, "reap.c");
    writeFileSync(source, REAPER_SOURCE);
    helper = join(dir, "bin", "cp-reap");
    const built = spawnSync("/usr/bin/cc", ["-O2", source, "-o", helper]);
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

  it("refuses a path that does not resolve to a file", () => {
    expect(untamperable(join(dir, "missing"))).toContain("cannot resolve");
    expect(untamperable(join(dir, "bin"))).toContain("not a regular file");
  });
});

describe("markConfinedSpawn", () => {
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
