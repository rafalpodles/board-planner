import { spawn } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";
import { createRunner, killGroup } from "./exec.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Both signals have already been sent by the time a run resolves — the direct child cannot outlive
// its own group. What this waits out is the kernel finishing them: process.kill(pid, 0) also
// succeeds for a process that is SIGKILLed but not yet scheduled to die, and for a grandchild
// sitting unreaped because its parent was killed in the same syscall. Neither holds a worktree.
// It never waits for a kill that has still to happen — nothing sends one after this point.
async function awaitDead(pid: number): Promise<void> {
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
}

interface Grandchildren {
  stubborn: number;
  obedient: number;
}

function pidFiles(label: string): { stubborn: string; obedient: string } {
  const stem = join(tmpdir(), `cp161-${label}-${process.pid}-${Date.now()}`);
  return { stubborn: `${stem}-stubborn`, obedient: `${stem}-obedient` };
}

// The shape a run actually has: `claude -p` and `npm test` spawn their own children, and those
// children are what hold the worktree open. Two of them, because terminate() sends two signals and
// each has to reach the group: `obedient` dies on the SIGTERM, `stubborn` only on the escalation.
//
// Each grandchild writes its own pid rather than having the parent report it, and writes it only
// once it is in the state the assertions rest on. spawn() returns a pid as soon as exec succeeds,
// which is before `-e` has run: a stubborn grandchild reported that early can still be signalled
// before its SIGTERM handler exists, and would then die on the SIGTERM it is here to survive.
function childSpawningGrandchildren(files: { stubborn: string; obedient: string }): string {
  const announce = (file: string): string =>
    `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid))`;
  const stubborn = `process.on('SIGTERM', () => {}); ${announce(files.stubborn)}; setInterval(() => {}, 1000)`;
  const obedient = `${announce(files.obedient)}; setInterval(() => {}, 1000)`;

  return `
    const { spawn } = require("child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { stdio: "ignore" });
    spawn(process.execPath, ["-e", ${JSON.stringify(obedient)}], { stdio: "ignore" });
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `;
}

function reap(files: { stubborn: string; obedient: string }): void {
  for (const file of Object.values(files)) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(file, { force: true });
  }
}

async function awaitGrandchildren(files: {
  stubborn: string;
  obedient: string;
}): Promise<Grandchildren> {
  await vi.waitFor(
    () => {
      expect(existsSync(files.stubborn)).toBe(true);
      expect(existsSync(files.obedient)).toBe(true);
    },
    { timeout: 5000 }
  );
  const pids = {
    stubborn: Number(readFileSync(files.stubborn, "utf8")),
    obedient: Number(readFileSync(files.obedient, "utf8")),
  };
  // Without this the kill assertions below pass just as well against a grandchild that never
  // started, which is the state a broken spawn would leave too
  expect(alive(pids.stubborn)).toBe(true);
  expect(alive(pids.obedient)).toBe(true);
  return pids;
}

// terminate() signalling only the direct child is what leaves a hung `npm test` running inside a
// worktree the pipeline removes the moment the run resolves.
describe("killing the whole process group", () => {
  it(
    "kills the grandchildren too when the run times out",
    async () => {
      const files = pidFiles("pg-timeout");

      try {
        const running = createRunner().run(
          process.execPath,
          ["-e", childSpawningGrandchildren(files)],
          { cwd: process.cwd(), timeoutMs: 1500 }
        );

        const pids = await awaitGrandchildren(files);
        const result = await running;

        expect(result.timedOut).toBe(true);
        await awaitDead(pids.obedient);
        await awaitDead(pids.stubborn);
      } finally {
        reap(files);
      }
    },
    30_000
  );

  it(
    "kills the grandchildren too when the run is aborted, on both signals",
    async () => {
      const files = pidFiles("pg-abort");
      const controller = new AbortController();

      try {
        const running = createRunner().run(
          process.execPath,
          ["-e", childSpawningGrandchildren(files)],
          { cwd: process.cwd(), timeoutMs: 60_000, signal: controller.signal }
        );

        const pids = await awaitGrandchildren(files);

        const abortedAt = Date.now();
        controller.abort();

        // The SIGTERM is the group kill, not just the escalation behind it: this one dies on the
        // first signal, well inside the grace period the SIGKILL waits out.
        await vi.waitFor(() => expect(alive(pids.obedient)).toBe(false), { timeout: 4000 });
        expect(Date.now() - abortedAt).toBeLessThan(4500);

        const result = await running;

        expect(result.timedOut).toBe(false);
        // ...and the escalation is a group kill too, or this one outlives the run
        await awaitDead(pids.stubborn);
      } finally {
        reap(files);
      }
    },
    30_000
  );
});

describe("killGroup", () => {
  it("treats a group that is already gone as done rather than as a failure", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", detached: true });
    const pid = child.pid;
    if (pid === undefined) throw new Error("the probe child did not spawn");

    await new Promise((resolve) => child.on("exit", resolve));

    // The precondition, not an aside: the group id is released with the pid, so by the time an
    // abort or a timeout lands on a child that has just exited, -pid is ESRCH. That race is
    // ordinary — it happens on every run that finishes near its deadline.
    expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/);

    let directKills = 0;
    const reaped = {
      pid,
      kill: (): boolean => {
        directKills += 1;
        return false;
      },
    };

    expect(() => killGroup(reaped, "SIGTERM")).not.toThrow();
    expect(() => killGroup(reaped, "SIGKILL")).not.toThrow();
    expect(directKills).toBe(0);
  });

  it("signals the direct child when there is no group of its own to signal", () => {
    // process.kill(-0) is process.kill(0): every process in the worker's own group, which is the
    // worker itself and whatever launched it. A child that never spawned has pid undefined.
    const signalled: (number | NodeJS.Signals | undefined)[] = [];
    const record = (signal?: number | NodeJS.Signals): boolean => {
      signalled.push(signal);
      return false;
    };

    // pid 0 deliberately gets the signal a broken guard would leave survivable, and -1 the one
    // that would otherwise be negated into an unrelated process to kill outright
    killGroup({ pid: undefined, kill: record }, "SIGKILL");
    killGroup({ pid: 0, kill: record }, "SIGTERM");
    killGroup({ pid: -1, kill: record }, "SIGTERM");

    expect(signalled).toEqual(["SIGKILL", "SIGTERM", "SIGTERM"]);
  });

  it("falls back to the direct child when the group cannot be signalled for any other reason", () => {
    let signalled = 0;
    const unsignallable = {
      // not a pid the kernel will ever be asked about: process.kill rejects it before any syscall
      pid: Number.MAX_SAFE_INTEGER,
      kill: (): boolean => {
        signalled += 1;
        return false;
      },
    };

    expect(() => killGroup(unsignallable, "SIGTERM")).not.toThrow();
    expect(signalled).toBe(1);
  });
});
