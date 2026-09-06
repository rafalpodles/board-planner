import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");

function filesCalling(name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (readFileSync(path, "utf8").includes(`${name}({`)) found.push(path);
      }
    }
  };
  walk(ROOT);
  return found;
}

const ATTENDED = ["pm/chat/route.ts"];

describe("every turn nobody is driving says so", () => {
  const callers = filesCalling("runPmTurn");

  it("finds the call sites at all, so this cannot pass by scanning nothing", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  for (const path of filesCalling("runPmTurn")) {
    const relative = path.slice(ROOT.length + 1);
    const attended = ATTENDED.some((a) => relative.replace(/\\/g, "/").endsWith(a));
    const source = readFileSync(path, "utf8");

    it(`${relative} ${attended ? "does not claim to be autonomous" : "passes autonomous: true"}`, () => {
      expect(/autonomous:\s*true/.test(source)).toBe(!attended);
    });
  }
});
