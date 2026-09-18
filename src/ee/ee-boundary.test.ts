import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EE = join(ROOT, "src", "ee");
const HEADER =
  "// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [path];
  });
}

describe("the licence boundary", () => {
  it("the repository root carries the AGPL v3", () => {
    const text = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(text).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(text).toContain("Version 3, 19 November 2007");
  });

  it("src/ee carries the Enterprise Edition licence", () => {
    expect(existsSync(join(EE, "LICENSE"))).toBe(true);
    expect(readFileSync(join(EE, "LICENSE"), "utf8")).toContain(
      "Board Planner Enterprise Edition Licence",
    );
  });

  it("every source file under src/ee opens with the EE header", () => {
    for (const file of sourceFiles(EE)) {
      const firstLine = readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
      expect(firstLine, file).toBe(HEADER);
    }
  });
});
