import { describe, expect, it } from "vitest";
import { horizontalMiss } from "./reachable";

describe("horizontalMiss", () => {
  it("accepts a box wholly inside, edges included", () => {
    expect(horizontalMiss({ x: 0, width: 390 }, 0, 390)).toBeNull();
    expect(horizontalMiss({ x: 100, width: 50 }, 0, 390)).toBeNull();
  });

  it("tolerates subpixel layout at either edge", () => {
    expect(horizontalMiss({ x: -0.4, width: 390.8 }, 0, 390)).toBeNull();
  });

  it("refuses a box that ends past the right edge", () => {
    expect(horizontalMiss({ x: 350, width: 60 }, 0, 390)).toMatch(/ends at 410, right of 390/);
  });

  it("refuses a box that starts left of the left edge", () => {
    expect(horizontalMiss({ x: -20, width: 60 }, 0, 390)).toMatch(/starts at -20, left of 0/);
  });

  it("measures against the edges it is given, not the viewport", () => {
    expect(horizontalMiss({ x: 20, width: 60 }, 30, 390)).toMatch(/left of 30/);
    expect(horizontalMiss({ x: 300, width: 60 }, 0, 340)).toMatch(/right of 340/);
  });

  it("refuses a missing or zero-width box, which toBeVisible would not tell from a real one", () => {
    expect(horizontalMiss(null, 0, 390)).toMatch(/no box/);
    expect(horizontalMiss({ x: 10, width: 0 }, 0, 390)).toMatch(/no width/);
  });
});
