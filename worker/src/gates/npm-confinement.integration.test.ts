import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../exec.js";
import { claimedTask } from "../__fixtures__/task.js";
import { GateContext } from "../types.js";
import { testRunGate } from "./test-run.js";

/**
 * BP-608, driven through the real kernel and a real `npm`.
 *
 * The chain BP-349 lengthened rather than closed: an Implement step writes a test file that writes
 * `$HOME/.claude/settings.json` — the write is inside the worktree, so the agent's own sandbox
 * permits it, and it is a *test*, which is exactly what the Test-presence gate asks for — and then
 * the Test gate executes it as the worker's uid, outside any profile. A later Implement step in
 * the same sequence loads the hook.
 *
 * A unit test can only say which arguments were composed, which is the shape of assertion that let
 * the hole stand while the profile was already there. This runs the suite.
 *
 * Skipped off macOS: there is no seatbelt to ask, and the gate refuses there — a refusal the unit
 * suite pins.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("the test gate against the real sandbox", () => {
  let dir = "";
  let worktree = "";
  let outside = "";

  const runner = createRunner();

  function context(): GateContext {
    return {
      worktreePath: worktree,
      task: claimedTask({ title: "t", description: "d" }),
      result: {
        status: "completed",
        summary: "",
        filesChanged: [],
        testsAdded: [],
        blockedReason: "",
      },
      diff: {
        changedLines: 1,
        changedFiles: ["a.js"],
        patch: "",
        truncated: false,
        headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
        symlinks: [],
        suppressedDiffs: [],
      },
    };
  }

  /** A worktree whose `npm test` runs this script, the way an agent's test file would. */
  function suiteThat(script: string) {
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ name: "wt", version: "1.0.0", scripts: { test: `node test.js` } })
    );
    writeFileSync(join(worktree, "test.js"), script);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp608-"));
    worktree = join(dir, "worktree");
    outside = join(dir, "home");
    mkdirSync(worktree);
    mkdirSync(outside);
    // `$HOME/.claude/settings.json`, played by a file this test owns
    writeFileSync(join(outside, "settings.json"), "original\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not let the suite write the file a hook would live in", async () => {
    suiteThat(
      `require("fs").writeFileSync(${JSON.stringify(join(outside, "settings.json"))}, "planted");`
    );

    const result = await testRunGate(runner, 120_000).run(context());

    // The suite fails because the write was denied, which is also how the operator finds out
    expect(result.ok).toBe(false);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  it("does not let it create one either, where none existed", async () => {
    const planted = join(outside, "new-hook.json");
    suiteThat(`require("fs").writeFileSync(${JSON.stringify(planted)}, "planted");`);

    const result = await testRunGate(runner, 120_000).run(context());

    expect(result.ok).toBe(false);
    expect(existsSync(planted)).toBe(false);
  });

  /**
   * The path the ticket is actually about, in the tree it is actually in: `$HOME`. The two above
   * are under the machine's temp tree, which this confinement also denies — a run gets a scratch
   * directory of its own rather than all of `/var/folders` — so without this the suite would not
   * be exercising the home directory at all.
   */
  it("does not let the suite write into the operator's home directory", async () => {
    const home = mkdtempSync(join(homedir(), "bp608-home-"));
    const planted = join(home, "settings.json");
    writeFileSync(planted, "original\n");
    suiteThat(`require("fs").writeFileSync(${JSON.stringify(planted)}, "planted");`);

    try {
      const result = await testRunGate(runner, 120_000).run(context());

      expect(result.ok).toBe(false);
      expect(readFileSync(planted, "utf8")).toBe("original\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The control, and the reason the confinement is not simply "deny everything": a suite that
  // writes fixtures, snapshots or coverage into its own repository still passes.
  it("lets an honest suite write inside the worktree", async () => {
    suiteThat(
      `require("fs").writeFileSync(${JSON.stringify(join(worktree, "coverage.txt"))}, "100%");`
    );

    const result = await testRunGate(runner, 120_000).run(context());

    expect(result.ok, result.reason).toBe(true);
    expect(readFileSync(join(worktree, "coverage.txt"), "utf8")).toBe("100%");
  });

  // The other half of honest: a suite that writes outside the repository on purpose, which is
  // ordinary, and which a confinement that broke it would get switched off for.
  it("lets an honest suite write to a temp directory", async () => {
    suiteThat(
      `const {mkdtempSync, writeFileSync} = require("fs");
       const {tmpdir} = require("os");
       const {join} = require("path");
       writeFileSync(join(mkdtempSync(join(tmpdir(), "suite-")), "scratch.txt"), "fine");`
    );

    const result = await testRunGate(runner, 120_000).run(context());

    expect(result.ok, result.reason).toBe(true);
  });
});
