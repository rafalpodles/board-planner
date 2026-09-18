import { describe, it, expect } from "vitest";
import { e2eOnlyMounted } from "./e2e-only";

/**
 * By value, across the matrix. The first version of this asserted against `process.env`, which in
 * vitest is `NODE_ENV=test` with no `E2E` — so it could observe one cell of four and the refusal
 * that matters, a production build carrying a stray `E2E=1`, was pinned by nothing.
 */
describe("a surface that exists only for the e2e suite", () => {
  it("is mounted under the suite's own environment", () => {
    expect(e2eOnlyMounted("1", "development")).toBe(true);
    expect(e2eOnlyMounted("1", "test")).toBe(true);
  });

  it("stays shut in a production build, whatever E2E says", () => {
    expect(e2eOnlyMounted("1", "production")).toBe(false);
  });

  it("stays shut without E2E, and is not fooled by a value that merely looks set", () => {
    expect(e2eOnlyMounted(undefined, "development")).toBe(false);
    expect(e2eOnlyMounted("", "development")).toBe(false);
    expect(e2eOnlyMounted("true", "development")).toBe(false);
    expect(e2eOnlyMounted("0", "development")).toBe(false);
  });
});
