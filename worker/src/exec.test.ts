import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";
import { createRunner } from "./exec.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await createRunner().run("node", ["-e", "process.stdout.write('hi')"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.timedOut).toBe(false);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const result = await createRunner().run("node", ["-e", "process.exit(3)"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(3);
  });

  it("flags a timeout", async () => {
    const result = await createRunner().run("node", ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });

  it("kills the process instead of waiting out its full lifetime", async () => {
    const start = Date.now();
    const result = await createRunner().run("node", ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it(
    "escalates to SIGKILL when the process ignores SIGTERM",
    async () => {
      const result = await createRunner().run(
        "node",
        ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000)"],
        { cwd: process.cwd(), timeoutMs: 200 },
      );
      expect(result.timedOut).toBe(true);
    },
    10000,
  );

  it("resolves exactly once with the informative error for a missing binary", async () => {
    const result = await createRunner().run("cp158-definitely-not-a-real-binary-xyz", [], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("ENOENT");
  });

  it("resolves instead of rejecting when spawn throws synchronously", async () => {
    const result = await createRunner().run("node", ["-e", "1", "a\0b"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(-1);
    expect(result.timedOut).toBe(false);
  });

  it("kills a running command when the signal aborts", async () => {
    const controller = new AbortController();
    const running = createRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    controller.abort();

    expect((await running).code).not.toBe(0);
  });

  it(
    "escalates an abort to SIGKILL and does not resolve while the child is still alive",
    async () => {
      const pidFile = join(tmpdir(), `cp161-abort-${process.pid}-${Date.now()}`);
      const controller = new AbortController();
      const running = createRunner().run(
        process.execPath,
        [
          "-e",
          `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        { cwd: process.cwd(), timeoutMs: 60_000, signal: controller.signal }
      );

      try {
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(alive(pid)).toBe(true);

        controller.abort();
        const result = await running;

        expect(alive(pid)).toBe(false);
        expect(result.code).not.toBe(0);
        expect(result.timedOut).toBe(false);
      } finally {
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8"));
          if (alive(pid)) process.kill(pid, "SIGKILL");
          rmSync(pidFile, { force: true });
        }
      }
    },
    20_000
  );

  it(
    "settles when a child exits but a grandchild keeps its inherited stdio open",
    async () => {
      const pidFile = join(tmpdir(), `cp161-grandchild-${process.pid}-${Date.now()}`);
      const start = Date.now();

      try {
        const result = await createRunner().run(
          process.execPath,
          [
            "-e",
            `
            const { spawn } = require("child_process");
            const fs = require("fs");
            const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
            fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
            process.exit(0);
            `,
          ],
          { cwd: process.cwd(), timeoutMs: 10_000 }
        );

        expect(result.code).toBe(0);
        expect(Date.now() - start).toBeLessThan(2000);
      } finally {
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8"));
          if (alive(pid)) process.kill(pid, "SIGKILL");
          rmSync(pidFile, { force: true });
        }
      }
    },
    5000
  );

  it("kills a command whose signal had already aborted before it was spawned", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await createRunner().run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(result.code).not.toBe(0);
  });

  it("passes a prompt on stdin rather than argv, where any process could read it", async () => {
    const result = await createRunner().run(
      process.execPath,
      ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      { cwd: process.cwd(), timeoutMs: 10_000, stdin: "secret-prompt" }
    );

    expect(result.stdout).toContain("secret-prompt");
  });

  it("closes stdin immediately when none is given, so a child reading it to EOF does not wait out the timeout", async () => {
    const start = Date.now();
    const result = await createRunner().run(
      process.execPath,
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
      { cwd: process.cwd(), timeoutMs: 3000 }
    );

    expect(result.timedOut).toBe(false);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe("watching stdout while it is still being written", () => {
  it("hands a chunk over before the process has exited", async () => {
    const chunks: string[] = [];
    let settled = false;

    const running = createRunner()
      .run(
        process.execPath,
        [
          "-e",
          "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 600)",
        ],
        { cwd: process.cwd(), timeoutMs: 10_000, onStdout: (chunk) => chunks.push(chunk) }
      )
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() => expect(chunks.join("")).toContain("first"));
    expect(settled).toBe(false);

    const result = await running;

    expect(chunks.join("")).toBe("first\nsecond\n");
    expect(result.stdout).toBe("first\nsecond\n");
  });

  it("keeps an observer's throw out of the process", async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => {
      uncaught.push(error);
    };

    process.on("uncaughtException", record);
    try {
      const result = await createRunner().run(
        process.execPath,
        ["-e", "process.stdout.write('payload')"],
        {
          cwd: process.cwd(),
          timeoutMs: 10_000,
          onStdout: () => {
            throw new Error("the observer exploded");
          },
        }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("payload");
      expect(result.timedOut).toBe(false);
    } finally {
      process.off("uncaughtException", record);
    }

    expect(uncaught).toEqual([]);
  });
});

describe("the default child environment", () => {
  it("hands a spawned process none of the worker's secrets", async () => {
    process.env.CP_API_TOKEN = "cp_secret_for_test";
    try {
      const result = await createRunner().run(
        process.execPath,
        ["-e", "console.log(process.env.CP_API_TOKEN ?? 'ABSENT')"],
        { cwd: process.cwd(), timeoutMs: 10_000 }
      );

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("ABSENT");
    } finally {
      delete process.env.CP_API_TOKEN;
    }
  });

  it("still hands it a PATH, or nothing would run at all", async () => {
    const result = await createRunner().run(
      process.execPath,
      ["-e", "console.log(process.env.PATH ? 'SET' : 'MISSING')"],
      { cwd: process.cwd(), timeoutMs: 10_000 }
    );

    expect(result.stdout.trim()).toBe("SET");
  });
});
