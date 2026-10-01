import { contrastRatio, relativeLuminance, type Rgb } from "../src/lib/contrast";

export interface Rgba extends Rgb {
  a: number;
}

export const AA_TEXT = 4.5;
export const DARK_SURFACE_MAX_LUMINANCE = 0.05;

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?`;

function numbers(body: string): number[] {
  return [...body.matchAll(new RegExp(NUMBER, "gi"))].map((m) => {
    const text = m[0];
    return text.endsWith("%") ? parseFloat(text) / 100 : parseFloat(text);
  });
}

function alphaOf(body: string): number {
  const slash = body.split("/")[1];
  if (slash !== undefined) return numbers(slash)[0] ?? 1;
  return 1;
}

function encodeSrgb(linear: number): number {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, v * 255));
}

function oklabToRgb(L: number, A: number, B: number): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function parseCssColour(value: string): Rgba {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const fn = /^([a-z]+)\((.*)\)$/.exec(text);
  if (!fn) throw new Error(`not a computed colour: ${value}`);
  const [, name, body] = fn;
  const [head] = body.split("/");

  if (name === "rgb" || name === "rgba") {
    const [r, g, b, legacyAlpha] = numbers(head);
    const a = body.includes("/") ? alphaOf(body) : (legacyAlpha ?? 1);
    return { r, g, b, a };
  }
  if (name === "color" && head.trim().startsWith("srgb")) {
    const [r, g, b] = numbers(head.trim().slice(4));
    return { r: r * 255, g: g * 255, b: b * 255, a: alphaOf(body) };
  }
  if (name === "oklab") {
    const [L, A, B] = numbers(head);
    return { ...oklabToRgb(L, A, B), a: alphaOf(body) };
  }
  if (name === "oklch") {
    const [L, C, H] = numbers(head);
    const h = (H * Math.PI) / 180;
    return { ...oklabToRgb(L, C * Math.cos(h), C * Math.sin(h)), a: alphaOf(body) };
  }
  throw new Error(`unsupported colour function: ${value}`);
}

export function over(top: Rgba, bottom: Rgb): Rgb {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
  };
}

const CANVAS: Rgb = { r: 255, g: 255, b: 255 };

/** Layers listed from the element outwards, as the browser reports them walking up the tree. */
export function paintedBackground(innermostFirst: string[]): Rgb {
  return innermostFirst
    .map(parseCssColour)
    .reduceRight<Rgb>((below, layer) => over(layer, below), CANVAS);
}

export interface PaintedText {
  color: string;
  backgrounds: string[];
}

export function textContrast({ color, backgrounds }: PaintedText): number {
  const background = paintedBackground(backgrounds);
  return contrastRatio(over(parseCssColour(color), background), background);
}

export function surfaceLuminance(backgrounds: string[]): number {
  return relativeLuminance(paintedBackground(backgrounds));
}
