import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

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
