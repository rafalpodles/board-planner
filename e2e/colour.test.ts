import { describe, expect, it } from "vitest";
import {
  over,
  paintedBackground,
  parseCssColour,
  surfaceLuminance,
  textContrast,
} from "./colour";

const close = (actual: { r: number; g: number; b: number }, expected: [number, number, number]) => {
  expect(actual.r).toBeCloseTo(expected[0], 0);
  expect(actual.g).toBeCloseTo(expected[1], 0);
  expect(actual.b).toBeCloseTo(expected[2], 0);
};

const near = (actual: { r: number; g: number; b: number }, expected: [number, number, number]) => {
  for (const [got, want] of [
    [actual.r, expected[0]],
    [actual.g, expected[1]],
    [actual.b, expected[2]],
  ]) {
    expect(Math.abs(got - want)).toBeLessThanOrEqual(1.5);
  }
};

describe("parseCssColour", () => {
  it("reads the legacy and the modern rgb syntax", () => {
    expect(parseCssColour("rgb(15, 23, 42)")).toEqual({ r: 15, g: 23, b: 42, a: 1 });
    expect(parseCssColour("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColour("rgb(10 20 30 / 0.25)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseCssColour("transparent").a).toBe(0);
  });

  it("reads what color-mix(in srgb) computes to", () => {
    const c = parseCssColour("color(srgb 1 0.5 0 / 0.5)");
    close(c, [255, 127.5, 0]);
    expect(c.a).toBe(0.5);
    expect(parseCssColour("color(srgb 0 0 1)").a).toBe(1);
  });

  it("converts oklab and oklch, which Tailwind's opacity modifiers compute to", () => {
    close(parseCssColour("oklab(1 0 0)"), [255, 255, 255]);
    close(parseCssColour("oklab(0 0 0)"), [0, 0, 0]);
    close(parseCssColour("oklab(0.20768 -0.00295 -0.03972)"), [15, 23, 42]);
    close(parseCssColour("oklch(0.6279 0.2577 29.23)"), [255, 0, 0]);
    expect(parseCssColour("oklab(0.5 0.1 -0.1 / 0.05)").a).toBe(0.05);
  });

  it("converts CIELAB lab and lch, which Tailwind's palette classes compute to", () => {
    near(parseCssColour("lab(100 0 0)"), [255, 255, 255]);
    near(parseCssColour("lab(0 0 0)"), [0, 0, 0]);
    near(parseCssColour("lab(54.29 80.8 69.89)"), [255, 0, 0]);
    near(parseCssColour("lch(54.29 106.84 40.85)"), [255, 0, 0]);
    near(parseCssColour("lab(29.568 68.287 -112.03)"), [0, 0, 255]);
    expect(parseCssColour("lab(50 20 20 / 0.4)").a).toBe(0.4);
  });

  it("reads a none component as zero, which makes an achromatic lch or oklch grey", () => {
    const grey = parseCssColour("oklch(0.6 0.1 none)");
    expect(grey).toEqual(parseCssColour("oklch(0.6 0.1 0)"));
    const achromatic = parseCssColour("lch(50 none none)");
    near(achromatic, [119, 119, 119]);
  });

  it("refuses a value it cannot read rather than guessing", () => {
    expect(() => parseCssColour("hwb(0 0% 0%)")).toThrow(/unsupported/);
    expect(() => parseCssColour("#fff")).toThrow(/not a computed colour/);
  });
});

describe("compositing", () => {
  it("blends a translucent layer over what is below", () => {
    close(over({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 }), [127.5, 127.5, 127.5]);
  });

  it("looks through transparent layers to the first painted ancestor", () => {
    close(paintedBackground(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(15, 23, 42)"]), [15, 23, 42]);
  });

  it("stacks translucent layers innermost on top", () => {
    close(paintedBackground(["rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)"]), [127.5, 127.5, 127.5]);
  });

  it("falls back to a white canvas when nothing is painted", () => {
    close(paintedBackground(["rgba(0, 0, 0, 0)"]), [255, 255, 255]);
  });
});

describe("what the spec measures", () => {
  it("scores the WCAG extremes", () => {
    expect(textContrast({ color: "rgb(0, 0, 0)", backgrounds: ["rgb(255, 255, 255)"] })).toBeCloseTo(21, 5);
    expect(textContrast({ color: "rgb(9, 9, 9)", backgrounds: ["rgb(9, 9, 9)"] })).toBeCloseTo(1, 5);
  });

  it("scores the app's own dark pair above AA and a muted grey on white below it", () => {
    const darkText = textContrast({ color: "rgb(241, 245, 249)", backgrounds: ["rgb(15, 23, 42)"] });
    expect(darkText).toBeGreaterThan(15);
    const pale = textContrast({ color: "rgb(170, 170, 170)", backgrounds: ["rgb(255, 255, 255)"] });
    expect(pale).toBeLessThan(4.5);
  });

  it("composites translucent text over its background before scoring it", () => {
    const solid = textContrast({ color: "rgb(255, 255, 255)", backgrounds: ["rgb(0, 0, 0)"] });
    const faded = textContrast({ color: "rgba(255, 255, 255, 0.3)", backgrounds: ["rgb(0, 0, 0)"] });
    expect(faded).toBeLessThan(solid / 3);
  });

  it("tells a dark surface from a light one by luminance", () => {
    expect(surfaceLuminance(["rgb(15, 23, 42)"])).toBeLessThan(0.05);
    expect(surfaceLuminance(["rgb(248, 250, 252)"])).toBeGreaterThan(0.9);
  });
});
