import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("apple-icon.png", () => {
  const png = readFileSync(new URL("./apple-icon.png", import.meta.url));

  it("is 180 px square", () => {
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it("has no alpha channel, because iOS fills transparency with black and masks the corners itself", () => {
    const COLOUR_TYPE_RGB = 2;
    expect(png[25]).toBe(COLOUR_TYPE_RGB);
  });
});
