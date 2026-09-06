import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const css = readFileSync(join(SRC, "app/globals.css"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("scrollbars are hidden app-wide", () => {
  it("hides the bar on every element in Firefox", () => {
    expect(css).toMatch(/^\*\s*\{[^}]*scrollbar-width:\s*none/m);
  });

  it("hides the bar on every element in WebKit", () => {
    expect(css).toMatch(/^\*::-webkit-scrollbar\s*\{[^}]*display:\s*none/m);
  });

  it("leaves no per-component opt-in utility to forget", () => {
    expect(css).not.toContain("no-scrollbar");
    const users = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("no-scrollbar")
    );
    expect(users.map((f) => f.replace(`${SRC}/`, ""))).toEqual([]);
  });

  it("does not touch overflow anywhere in the global rules", () => {
    const globalRules = css.match(/^\*[^{]*\{[^}]*\}/gm) ?? [];
    expect(globalRules).not.toHaveLength(0);
    for (const rule of globalRules) expect(rule).not.toMatch(/[^-]overflow:/);
  });
});
