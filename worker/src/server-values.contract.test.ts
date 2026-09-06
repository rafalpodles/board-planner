import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKER_SHAPES = join(import.meta.dirname, "config.ts");
const APP_SHAPES = join(import.meta.dirname, "..", "..", "src", "lib", "worker-policy.ts");

function shapeBlock(path: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("const GIT_REF_NAME");
  const end = source.indexOf("}", source.indexOf("export function isModelName"));
  expect(start, `${path} defines GIT_REF_NAME`).toBeGreaterThan(-1);
  expect(end, `${path} defines isModelName`).toBeGreaterThan(start);
  return source.slice(start, end + 1).trim();
}

describe("the shapes a policy value must have", () => {
  it("are written identically on the worker and on the server", () => {
    expect(shapeBlock(WORKER_SHAPES)).toBe(shapeBlock(APP_SHAPES));
  });
});
