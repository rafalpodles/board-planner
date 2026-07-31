import { describe, it, expect } from "vitest";
import { testPresenceGate } from "./test-presence.js";
import { DiffStats, GateContext } from "../types.js";

function context(diff: Partial<DiffStats>): GateContext {
  return {
    worktreePath: "/wt",
    task: {
      taskId: "1",
      taskKey: "CP-1",
      taskNumber: 1,
      title: "t",
      description: "d",
      acceptanceCriteria: [],
      attempts: 0,
    },
    result: {
      status: "completed",
      summary: "",
      filesChanged: [],
      testsAdded: [],
      blockedReason: "",
    },
    diff: { changedLines: 10, changedFiles: [], patch: "", truncated: false, ...diff },
  };
}

const sourceHunk = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
];

const addedTestHunk = (path: string) => [
  `diff --git a/${path} b/${path}`,
  "index 3333333..4444444 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1 +1,2 @@",
  ' it("works", () => {});',
  '+it("handles two", () => {});',
];

const deletedTestHunk = (path: string) => [
  `diff --git a/${path} b/${path}`,
  "deleted file mode 100644",
  "index 3333333..0000000",
  `--- a/${path}`,
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  ' it("works", () => {});',
];

describe("testPresenceGate", () => {
  it("accepts a diff that adds lines to a test file", async () => {
    const result = await testPresenceGate().run(
      context({
        changedFiles: ["src/a.ts", "src/a.test.ts"],
        patch: [...sourceHunk, ...addedTestHunk("src/a.test.ts")].join("\n"),
      })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a diff with no test file", async () => {
    const result = await testPresenceGate().run(
      context({ changedFiles: ["src/a.ts"], patch: sourceHunk.join("\n") })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no test/i);
  });

  it.each(["src/A.test.tsx", "src/a.spec.ts", "src/a.test.js"])(
    "recognises %s as a test file",
    async (path) => {
      const result = await testPresenceGate().run(
        context({
          changedFiles: ["src/a.ts", path],
          patch: [...sourceHunk, ...addedTestHunk(path)].join("\n"),
        })
      );
      expect(result.ok).toBe(true);
    }
  );

  it("rejects a diff whose only test change deletes the test", async () => {
    const result = await testPresenceGate().run(
      context({
        changedFiles: ["src/a.ts", "src/a.test.ts"],
        patch: [...sourceHunk, ...deletedTestHunk("src/a.test.ts")].join("\n"),
      })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/src\/a\.test\.ts/);
  });

  it("accepts a documentation-only diff with no test", async () => {
    const result = await testPresenceGate().run(
      context({ changedFiles: ["README.md", "package.json"], patch: "" })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an empty diff rather than vacuously exempting it", async () => {
    const result = await testPresenceGate().run(context({ changedFiles: [], patch: "" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no committed changes/i);
  });

  it("falls back to the file list when the patch was truncated", async () => {
    const result = await testPresenceGate().run(
      context({ changedFiles: ["src/a.ts", "src/a.test.ts"], patch: "", truncated: true })
    );
    expect(result.ok).toBe(true);
  });
});
