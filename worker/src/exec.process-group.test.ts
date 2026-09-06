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
  expect(alive(pids.stubborn)).toBe(true);
  expect(alive(pids.obedient)).toBe(true);
  return pids;
}

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

        await vi.waitFor(() => expect(alive(pids.obedient)).toBe(false), { timeout: 4000 });
        expect(Date.now() - abortedAt).toBeLessThan(4500);

        const result = await running;

        expect(result.timedOut).toBe(false);
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
    const signalled: (number | NodeJS.Signals | undefined)[] = [];
    const record = (signal?: number | NodeJS.Signals): boolean => {
      signalled.push(signal);
      return false;
    };

    const realKill = process.kill;
    const groupKills: number[] = [];
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      groupKills.push(pid);
      return realKill.call(process, pid, signal);
    }) as typeof process.kill;

    try {
      killGroup({ pid: undefined, kill: record }, "SIGKILL");
      killGroup({ pid: 0, kill: record }, "SIGTERM");
      killGroup({ pid: -1, kill: record }, "SIGTERM");
    } finally {
      process.kill = realKill;
    }

    expect(signalled).toEqual(["SIGKILL", "SIGTERM", "SIGTERM"]);
    expect(groupKills).toEqual([]);
  });

  it("falls back to the direct child when the group cannot be signalled for any other reason", () => {
    let signalled = 0;
    const unsignallable = {
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
