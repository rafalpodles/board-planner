import { describe, it, expect } from "vitest";
import { estimateImageTokens, MAX_IMAGE_DIMENSION } from "./image-resize";

describe("estimateImageTokens", () => {
  it("follows width*height/750", () => {
    expect(estimateImageTokens(1200, 800)).toBe(1280);
    expect(estimateImageTokens(1568, 1045)).toBe(2185);
  });

  it("grows with area", () => {
    expect(estimateImageTokens(1568, 1568)).toBeGreaterThan(estimateImageTokens(800, 800));
  });

  it("returns a whole number", () => {
    expect(Number.isInteger(estimateImageTokens(333, 777))).toBe(true);
  });

  it("bounds the worst case a downscaled image can reach", () => {
    const worst = estimateImageTokens(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION);
    expect(worst).toBeLessThan(3500);
  });
});
