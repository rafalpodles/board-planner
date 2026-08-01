import { describe, it, expect } from "vitest";
import { estimateImageTokens, MAX_IMAGE_DIMENSION } from "./image-resize";

describe("estimateImageTokens", () => {
  // Claude bills an image at roughly width*height/750; this is the number the composer
  // shows, so it should stay honest rather than drift into decoration
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

  // The cap is the whole point of downscaling: it bounds what a single image can cost
  it("bounds the worst case a downscaled image can reach", () => {
    const worst = estimateImageTokens(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION);
    expect(worst).toBeLessThan(3500);
  });
});
