import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVATAR_PALETTE_SIZE, avatarColorIndex, avatarStyle } from "./avatar-color";
import { contrastRatio, parseHex } from "./contrast";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function block(marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`missing block: ${marker}`);
  return css.slice(start, css.indexOf("}", start));
}

function palette(source: string): string[] {
  const colours: string[] = [];
  for (const [, index, value] of source.matchAll(/--avatar-(\d+):\s*(#[0-9a-fA-F]{6});/g)) {
    colours[Number(index)] = value;
  }
  return colours;
}

const text = (source: string) => /--color-text:\s*(#[0-9a-fA-F]{6});/.exec(source)![1];

const dark = { palette: palette(block(":root {")), text: text(block("@theme {")) };
const light = { palette: palette(block('[data-theme="light"]')), text: text(block('[data-theme="light"]')) };

describe("avatarColorIndex", () => {
  it("gives the same person the same index every time", () => {
    expect(avatarColorIndex("rafal")).toBe(avatarColorIndex("rafal"));
  });

  it("ignores case and surrounding space, so a username typed two ways is one colour", () => {
    expect(avatarColorIndex("  Rafal ")).toBe(avatarColorIndex("rafal"));
  });

  it("stays inside the palette", () => {
    for (const key of ["", "a", "ł", "😀", "a-very-long-username-".repeat(20)]) {
      const index = avatarColorIndex(key);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(AVATAR_PALETTE_SIZE);
    }
  });

  it("uses every colour, none by a big share of 500 names", () => {
    const counts = new Array(AVATAR_PALETTE_SIZE).fill(0);
    for (let i = 0; i < 500; i++) counts[avatarColorIndex(`user${i}`)]++;
    expect(counts.every((c) => c > 0)).toBe(true);
    expect(Math.max(...counts)).toBeLessThan(500 * 0.2);
  });

  it("tells apart usernames that differ by one character", () => {
    const seen = new Set(["alice", "alicf", "alicd", "alice1", "alic", "blice"].map(avatarColorIndex));
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe("avatarStyle", () => {
  it("points the background at the palette variable of the hashed index", () => {
    expect(avatarStyle("rafal")).toEqual({
      backgroundColor: `var(--avatar-${avatarColorIndex("rafal")})`,
    });
  });

  it.each([undefined, null, "", "   "])("has no style for %j", (key) => {
    expect(avatarStyle(key)).toBeUndefined();
  });
});

describe("the palette in globals.css", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])("has %s colours for every index", (_name, theme) => {
    expect(theme.palette).toHaveLength(AVATAR_PALETTE_SIZE);
    expect(theme.palette.every(Boolean)).toBe(true);
    expect(new Set(theme.palette).size).toBe(AVATAR_PALETTE_SIZE);
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("carries the %s theme's text at AA on every colour", (_name, theme) => {
    theme.palette.forEach((colour, index) => {
      const ratio = contrastRatio(parseHex(theme.text), parseHex(colour));
      expect(ratio, `--avatar-${index} ${colour} against ${theme.text}`).toBeGreaterThanOrEqual(4.5);
    });
  });
});
