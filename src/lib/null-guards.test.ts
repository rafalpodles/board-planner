import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * `typeof null === "object"`, so `typeof x === "object" ? x.y : fallback` sends a null
 * reference down the *populated* branch and throws. CP-249 shipped that to production in
 * eight places at once. A guard has to come first: `x && typeof x === "object"`, or an
 * explicit `x !== null` alongside.
 *
 * This walks the source rather than testing one component, so a new occurrence fails here
 * the moment it is written — including in files that have no test of their own.
 */

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

/** Reads back the operand of a `typeof <operand> === "object"` match. */
function operandOf(match: string): string {
  return match.replace(/^typeof\s+/, "").replace(/\s*[!=]==.*$/, "").trim();
}

/**
 * A guard may sit in the same expression (`x && typeof x === "object"`), on an enclosing
 * `if` a line or two above, or trail as an explicit null check — so look at a window of
 * surrounding text rather than the matched line alone.
 */
function isGuarded(source: string, index: number, operand: string): boolean {
  const before = source.slice(Math.max(0, index - 220), index);
  const after = source.slice(index, index + 220);
  const escaped = operand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (
    // same expression: `x && typeof x === "object"`
    new RegExp(`${escaped}\\s*&&`).test(before) ||
    // enclosing condition: `if (something && x) { … typeof x === "object"`
    new RegExp(`(?:if\\s*\\(|&&\\s*)${escaped}\\s*[)&]`).test(before) ||
    // early return on the negated form: `if (!x || typeof x !== "object") return`
    new RegExp(`!\\s*${escaped}\\s*(?:\\|\\||&&)`).test(before) ||
    // explicit null check on either side
    new RegExp(`${escaped}\\s*!==\\s*null`).test(after) ||
    new RegExp(`${escaped}\\s*!==\\s*null`).test(before) ||
    // the validator idiom: `typeof x !== "object" || x === null` rejects null in the same test
    new RegExp(`${escaped}\\s*===\\s*null`).test(after) ||
    // defaulted on assignment: `const x = maybe || {}` cannot be null by the time it is read
    new RegExp(`${escaped}\\s*=\\s*[^;\\n]*(?:\\|\\||\\?\\?)\\s*[{[]`).test(before)
  );
}

/**
 * Comparing two values by shape never dereferences either one, so a guard would be noise.
 * Keep this list short — every entry is a place this test cannot vouch for.
 */
const ALLOWED = new Set(["src/hooks/use-draft.ts"]);

describe("null guards", () => {
  it('guards every `typeof x === "object"` against null', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(process.cwd().length + 1);
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      // Both polarities: `=== "object"` dereferences in the true branch, `!== "object"`
      // in whatever follows an early return that never fired for null.
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
