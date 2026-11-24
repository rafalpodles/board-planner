import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

const PATCHED_BROTLI_DECODER = [26, 12, 1];

function floorOf(range: string): number[] {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) throw new Error(`engines.node is not a plain ">=x.y.z" floor: ${range}`);
  return match.slice(1).map(Number);
}

function atLeast(version: number[], floor: number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

describe("the Node floor keeps CVE-2026-111497 out (BP-1160)", () => {
  const declared = JSON.parse(read("package.json")).engines.node as string;

  it("declares a Node with the patched Brotli decoder", () => {
    expect(atLeast(floorOf(declared), PATCHED_BROTLI_DECODER)).toBe(true);
  });

  it("records the same floor in the lockfile", () => {
    expect(JSON.parse(read("package-lock.json")).packages[""].engines.node).toBe(declared);
  });

  it("makes npm refuse an older Node instead of warning", () => {
    expect(read(".npmrc").split("\n").map((line) => line.trim())).toContain("engine-strict=true");
  });

  it("has the image's install see that setting", () => {
    const dockerfile = read("Dockerfile").split("\n");
    const install = dockerfile.findIndex((line) => /^RUN npm ci\b/.test(line));
    const stage = dockerfile.slice(0, install).findLastIndex((line) => /^FROM\b/.test(line));
    const copy = dockerfile.findIndex((line) => /^COPY\s+(\S+\s+)*\.npmrc\s+(\S+\s+)*\.\/$/.test(line));
    expect(install).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(stage);
    expect(copy).toBeLessThan(install);
  });
});
