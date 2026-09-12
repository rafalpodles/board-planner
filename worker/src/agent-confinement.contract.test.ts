import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BP-349. `confine()` is only a rule if every spawn of the agent goes through it, and there is
 * nothing about `runner.run("claude", …)` that looks wrong — it is what both call sites said until
 * this ticket, and a third one added next year would read exactly as correct.
 *
 * A tripwire, not a test of behaviour: when it fails, wrap the new spawn in `confine()` and refuse
 * the step when it answers with a refusal, the way executor.ts and gates/review.ts do.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

// The implementer step and the review gate. Nothing else in this package runs the CLI.
const MAY_SPAWN_THE_AGENT = ["executor.ts", "gates/review.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [relative(SRC, path)];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(join(SRC, file), "utf8")))
    .sort();
}

describe("every spawn of the agent is confined", () => {
  // Both call sites hand `runner.run` what `confine` gave back, so the CLI's own name survives only
  // as confine's first argument. A spawn that names it directly has not been through anything.
  it("no source file hands the CLI's name straight to the runner", () => {
    expect(filesMatching(/\.run\(\s*"claude"/)).toEqual([]);
  });

  it("only the implementer step and the review gate run the agent at all", () => {
    expect(filesMatching(/confine\(\s*"claude"/)).toEqual(MAY_SPAWN_THE_AGENT);
  });

  // What each of them does with a refusal is behaviour, and asserted as behaviour: executor.test.ts
  // fails the step without spawning, review.test.ts refuses the change. A third text match here
  // would go red on a rename and catch nothing those two do not.
});
