import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `childEnv()` is only a rule if every spawn site goes through it. A single `{ ...process.env }`
 * hands the child everything the worker holds — CP_API_TOKEN writes to the board as the operator,
 * GH_TOKEN pushes as them — and it reads as harmless next to a `delete` of the one variable the
 * author had in mind. That is how the review gate leaked for as long as it did.
 *
 * This is a tripwire, not a test of behaviour: when it fails, build the child environment with
 * childEnv(), naming any extra variable the child genuinely needs.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

// env.ts turns the worker's environment into the allowlist; wiring.ts is where the worker reads
// its own configuration and repairs its own PATH. Neither hands it to a child.
const MAY_READ_PROCESS_ENV = ["env.ts", "wiring.ts"];

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

describe("every subprocess environment is built from the allowlist", () => {
  it("no source file spreads the worker's environment into a child", () => {
    expect(filesMatching(/\.\.\.\s*process\.env/)).toEqual([]);
  });

  it("only env.ts and wiring.ts read process.env at all", () => {
    expect(filesMatching(/process\.env/)).toEqual(MAY_READ_PROCESS_ENV);
  });
});
