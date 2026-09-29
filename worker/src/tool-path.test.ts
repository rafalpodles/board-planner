import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireToolPath } from "./tool-path.js";

describe("requireToolPath", () => {
  it("refuses an unresolved path rather than falling back to the name", () => {
    expect(() => requireToolPath("gh", "")).toThrow(
      "no absolute gh path was resolved — refusing to run gh by name on PATH",
    );
  });

  it("refuses the bare name itself", () => {
    expect(() => requireToolPath("npm", "npm")).toThrow("no absolute npm path was resolved");
  });

  it("passes a resolved path through unchanged", () => {
    expect(requireToolPath("claude", "/Users/me/.local/bin/claude")).toBe("/Users/me/.local/bin/claude");
  });
});

// The same shape as git-safety.test.ts's scan (BP-641): a tripwire over the source, because a
// spawn by name reads exactly as correct as one by path.
function sources(): { file: string; source: string }[] {
  const dir = import.meta.dirname;
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function filesMatching(pattern: RegExp): string[] {
  return sources()
    .filter(({ source }) => pattern.test(source))
    .map(({ file }) => file);
}

describe("every preflight-resolved tool is spawned by its path", () => {
  it("names none of them to a runner or to confine", () => {
    expect(filesMatching(/\b(run|confine)\(\s*["'](git|gh|claude|npm)["']/)).toEqual([]);
  });

  // The controls: the assertion above is "nothing matches", which a scan that stopped reading the
  // right files would satisfy for ever.
  it("finds each spawn where it goes through the composition point", () => {
    expect(filesMatching(/\brun\(\s*requireToolPath\("gh"/)).toEqual(["delivery.ts"]);
    expect(filesMatching(/confineTool\(\s*"claude"/)).toEqual(["executor.ts", "gates/review.ts"]);
    expect(filesMatching(/confineTool\(\s*"npm"/)).toEqual(["gates/confined-npm.ts"]);
  });
});
