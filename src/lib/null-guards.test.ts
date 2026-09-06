import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function operandOf(match: string): string {
  return match.replace(/^typeof\s+/, "").replace(/\s*[!=]==.*$/, "").trim();
}

function isGuarded(source: string, index: number, operand: string): boolean {
  const before = source.slice(Math.max(0, index - 220), index);
  const after = source.slice(index, index + 220);
  const escaped = operand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (
    new RegExp(`${escaped}\\s*&&`).test(before) ||
    new RegExp(`(?:if\\s*\\(|&&\\s*)${escaped}\\s*[)&]`).test(before) ||
    new RegExp(`!\\s*${escaped}\\s*(?:\\|\\||&&)`).test(before) ||
    new RegExp(`${escaped}\\s*!==\\s*null`).test(after) ||
    new RegExp(`${escaped}\\s*!==\\s*null`).test(before) ||
    new RegExp(`${escaped}\\s*===\\s*null`).test(after) ||
    new RegExp(`${escaped}\\s*=\\s*[^;\\n]*(?:\\|\\||\\?\\?)\\s*[{[]`).test(before)
  );
}

const ALLOWED = new Set(["src/hooks/use-draft.ts"]);

describe("null guards", () => {
  it('guards every `typeof x === "object"` against null', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(process.cwd().length + 1);
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      const pattern = /typeof\s+[\w.[\]"']+\s*[!=]==\s*"object"/g;

      for (const match of source.matchAll(pattern)) {
        const operand = operandOf(match[0]);
        if (isGuarded(source, match.index, operand)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line} — ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
