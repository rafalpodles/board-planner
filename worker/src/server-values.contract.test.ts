import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shapes a server-supplied policy value has to have are checked twice: once where an admin
 * sets it (src/lib/worker-policy.ts) and once where a worker accepts it (worker/src/config.ts).
 * Two checks are the point — a worker takes its policy from whatever server it is enrolled with,
 * so the app's own validation is not the only thing standing there — but two copies can drift, and
 * the drift that matters is the loose one: a worker that keeps accepting what the app stopped
 * storing. Same shape as catalog-contract.test.ts: read both as text and compare.
 */
const WORKER_SHAPES = join(import.meta.dirname, "config.ts");
const APP_SHAPES = join(import.meta.dirname, "..", "..", "src", "lib", "worker-policy.ts");

// From the first pattern to the end of isModelName — the whole block, comments excluded, so a
// changed regex, a dropped clause and a changed length cap all show up as one mismatch.
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
