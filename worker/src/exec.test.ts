import { describe, it, expect } from "vitest";
import { createRunner } from "./exec.js";

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
});

describe("the default child environment", () => {
  // Every gate calls runner.run without an env of its own, so this default is what npm ci,
  // npm run build and npm test actually inherit — including any dependency's lifecycle script
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
