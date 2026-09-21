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

// `process.env`, `process["env"]`/`process['env']`, and a destructured `env` — `import { env } from
// "node:process"`, `const { env } = process` — are the same read spelled four ways. BP-310 ranked
// all three of the non-dotted forms "low" plausibility and "free to close by widening the regex".
// A file that only destructures `env` and uses it later (`const { env } = process; …spread(env)`)
// still fails the read-restriction test below on the destructuring line alone, so the spread regex
// only needs the two `process.env`-shaped spellings — it does not have to chase the local name too.
const PROCESS_ENV_READ = /process(?:\.env|\s*\[\s*["']env["']\s*\])|from\s*["']node:process["']|\{\s*env\s*\}\s*=\s*process\b/;
const PROCESS_ENV_SPREAD = /\.\.\.\s*process(?:\.env|\s*\[\s*["']env["']\s*\])/;

describe("every subprocess environment is built from the allowlist", () => {
  it("no source file spreads the worker's environment into a child", () => {
    expect(filesMatching(PROCESS_ENV_SPREAD)).toEqual([]);
  });

  it("only env.ts and wiring.ts read process.env at all", () => {
    expect(filesMatching(PROCESS_ENV_READ)).toEqual(MAY_READ_PROCESS_ENV);
  });
});
