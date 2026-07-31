import { describe, it, expect } from "vitest";
import { diffSizeGate } from "./diff-size.js";

const context = (changedLines: number, changedFiles: string[]) =>
  ({ diff: { changedLines, changedFiles, patch: "" } }) as never;

describe("diffSizeGate", () => {
  it("accepts a small diff", async () => {
    const result = await diffSizeGate(400, 10).run(context(50, ["a.ts"]));
    expect(result.ok).toBe(true);
  });

  it("accepts a diff exactly at the limit", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const result = await diffSizeGate(400, 10).run(context(400, files));
    expect(result.ok).toBe(true);
  });

  it("rejects too many lines and names the threshold", async () => {
    const result = await diffSizeGate(400, 10).run(context(401, ["a.ts"]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/401.*400/);
  });

  it("rejects too many files", async () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const result = await diffSizeGate(400, 10).run(context(10, files));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/11.*10/);
  });
});
