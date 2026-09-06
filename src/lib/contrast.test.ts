import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chipContrast, chipCustomContrast, contrastRatio, parseHex } from "./contrast";

const PROJECT_PICKED = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4"];

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6});/g)) {
    out[name] = value;
  }
  return out;
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`missing block: ${marker}`);
  return css.slice(start, css.indexOf("}", start));
}

const dark = tokens(blockAfter("@theme {"));
const lightOverrides = tokens(blockAfter('[data-theme="light"]'));
const light = { ...dark, ...lightOverrides };

const ACCENTS = [
  "--color-primary",
  "--color-danger",
  "--color-success",
  "--color-warning",
  "--color-status-planned",
  "--color-status-todo",
  "--color-status-in-progress",
  "--color-status-in-review",
  "--color-status-needs-human-review",
  "--color-status-ready-to-test",
  "--color-status-done",
  "--color-difficulty-s",
  "--color-difficulty-m",
  "--color-difficulty-l",
  "--color-difficulty-xl",
  "--color-priority-low",
  "--color-priority-medium",
  "--color-priority-high",
  "--color-priority-urgent",
];

const AA = 4.5;
const THEMES: [string, Record<string, string>][] = [
  ["dark", dark],
  ["light", light],
];

describe("chip contrast", () => {
  for (const [name, theme] of THEMES) {
    describe(name, () => {
      for (const accent of ACCENTS) {
        it(`${accent} clears AA on a chip`, () => {
          const ratio = chipContrast(
            parseHex(theme[accent]),
            parseHex(theme["--color-bg-card"]),
            parseHex(theme["--color-text"])
          );
          expect(ratio).toBeGreaterThanOrEqual(AA);
        });
      }
    });
  }
});

describe("chip with a project-picked colour", () => {
  for (const [name, theme] of THEMES) {
    for (const picked of PROJECT_PICKED) {
      it(`${name}: ${picked} clears AA`, () => {
        const ratio = chipCustomContrast(
          parseHex(picked),
          parseHex(theme["--color-bg-card"]),
          parseHex(theme["--color-text"])
        );
        expect(ratio).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});

describe("solid surfaces carrying white text", () => {
  const white = parseHex("#ffffff");
  const SOLIDS = [
    "--color-primary-solid",
    "--color-primary-solid-hover",
    "--color-danger-solid",
    "--color-danger-solid-hover",
    "--color-success-solid",
  ];
  for (const token of SOLIDS) {
    it(`${token} clears AA against white`, () => {
      expect(contrastRatio(white, parseHex(dark[token]))).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe("accent text on the page background", () => {
  for (const [name, theme] of THEMES) {
    for (const token of ACCENTS) {
      it(`${name}: ${token} clears AA as text`, () => {
        const ratio = contrastRatio(parseHex(theme[token]), parseHex(theme["--color-bg"]));
        expect(ratio).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});

describe("muted text", () => {
  for (const [name, theme] of THEMES) {
    it(`${name}: clears AA on the input surface`, () => {
      const ratio = contrastRatio(
        parseHex(theme["--color-text-muted"]),
        parseHex(theme["--color-bg-input"])
      );
      expect(ratio).toBeGreaterThanOrEqual(AA);
    });

    it(`${name}: clears AA on the page background`, () => {
      const ratio = contrastRatio(
        parseHex(theme["--color-text-muted"]),
        parseHex(theme["--color-bg"])
      );
      expect(ratio).toBeGreaterThanOrEqual(AA);
    });
  }
});
