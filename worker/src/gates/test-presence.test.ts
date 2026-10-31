import { describe, it, expect } from "vitest";
import { testPresenceGate } from "./test-presence.js";
import { DiffStats, GateContext } from "../types.js";
import { claimedTask } from "../__fixtures__/task.js";
import { gateCommandsOf } from "./gate-commands.js";

const OWN = gateCommandsOf({ testCommand: "go test ./..." });

function context(diff: Partial<DiffStats>): GateContext {
  return {
    worktreePath: "/wt",
    worktreeDir: { path: "/wt", dev: 0, ino: 0 },
    gateHome: { path: "/wt.home", dev: 0, ino: 1 },
    checkoutGitDir: "/repo/.git",
    task: claimedTask({ taskKey: "CP-1", taskNumber: 1, title: "t", description: "d" }),
    result: {
      status: "completed",
      summary: "",
      filesChanged: [],
      testsAdded: [],
      blockedReason: "",
    },
    diff: { changedLines: 10, changedFiles: [], patch: "", truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", symlinks: [], suppressedDiffs: [], gitlinks: [], ...diff },
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

  it.each([
    "tests/test_login.py",
    "app/login_test.py",
    "pkg/login_test.go",
    "tests/login.rs",
    "src/test/java/LoginTest.java",
    "LoginTest.kt",
    "spec/login_spec.rb",
    "Tests/LoginTests.swift",
    "test/login_test.exs",
    "test/login_test.dart",
    "src/login_test.cc",
    "Tests/URLTests.swift",
    "tests/APITest.php",
    "app/src/androidTest/java/JWTTest.kt",
    "src/main/java/LoginIT.java",
  ])("takes %s for a test, so a repository on its own gate commands can pass", async (path) => {
    const verdict = await testPresenceGate(OWN).run(context({ changedFiles: ["src/login.x", path], patch: [`+++ b/${path}`, "+assert ok"].join("\n") }));

    expect(verdict).toMatchObject({ ok: true });
  });

  it("takes none of those for a test on the npm gates, where `npm test` never runs them", async () => {
    const verdict = await testPresenceGate().run(context({ changedFiles: ["src/billing.ts", "tools/foo_test.py"], patch: ["+++ b/tools/foo_test.py", "+assert ok"].join("\n") }));

    expect(verdict).toMatchObject({ ok: false, reason: "no test file was added or changed" });
  });

  it("wants a test for a task-runner file on a project's own commands, which runs in its gates", async () => {
    const taskfile = { changedFiles: ["Taskfile.yml"], patch: "+++ b/Taskfile.yml\n+x" };

    expect((await testPresenceGate(OWN).run(context(taskfile))).ok).toBe(false);
    expect((await testPresenceGate().run(context(taskfile))).ok).toBe(true);
  });

  it.each(["login.py", "pkg/login.go", "src/login.rs", "contest_results.py", "Latest.java", "AUDIT.java", "GIT.kt"])("does not take %s for a test", async (path) => {
    const verdict = await testPresenceGate(OWN).run(context({ changedFiles: [path], patch: [`+++ b/${path}`, "+x"].join("\n") }));

    expect(verdict).toMatchObject({ ok: false, reason: "no test file was added or changed" });
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
      context({ changedFiles: ["README.md", "docs/setup.md"], patch: "" })
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a lockfile-only dependency bump with no test", async () => {
    const result = await testPresenceGate().run(
      context({ changedFiles: ["package-lock.json"], patch: "" })
    );
    expect(result.ok).toBe(true);
  });

  it.each(["package.json", "worker/package.json", ".github/workflows/ci.yml"])(
    "never exempts %s, which defines what a later gate runs",
    async (path) => {
      const result = await testPresenceGate().run(
        context({ changedFiles: ["README.md", path], patch: "" })
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no test/i);
    }
  );

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

  // BP-333. `.toml` was in the no-test-expected list and the exception list named only package.json
  // and .github/, so a change touching nothing but a build backend was waved through as needing no
  // test — in exactly the repositories none of these gates can otherwise check.
  it.each([
    "pyproject.toml",
    "Cargo.toml",
    "docker-compose.yml",
    ".gitlab-ci.yml",
    "composer.json",
    "pubspec.yaml",
  ])("requires a test for %s, which decides what runs", async (file) => {
    const result = await testPresenceGate().run(context({ changedFiles: [file], patch: "" }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no test file/);
  });

  // The one place this gate and protected-paths deliberately disagree: a resolver output is not a
  // decision somebody has to write a test for, while the manifest beside it is
  it.each(["poetry.lock", "Gemfile.lock", "Cargo.lock", "go.sum", "pnpm-lock.yaml"])(
    "still accepts a %s bump with no test",
    async (file) => {
      expect((await testPresenceGate().run(context({ changedFiles: [file], patch: "" }))).ok).toBe(true);
    }
  );

  // Documentation and assets are the reason the exemption exists at all — it has to keep working
  it("still accepts a docs-only change", async () => {
    const result = await testPresenceGate().run(
      context({ changedFiles: ["README.md", "docs/guide.mdx", "public/logo.svg"], patch: "" })
    );

    expect(result.ok).toBe(true);
  });
});
