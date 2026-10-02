import { contrastRatio, relativeLuminance, type Rgb } from "../src/lib/contrast";

export interface Rgba extends Rgb {
  a: number;
}

export const AA_TEXT = 4.5;
export const DARK_SURFACE_MAX_LUMINANCE = 0.05;
export const DARK_INPUT_MAX_LUMINANCE = 0.06;

const COMPONENT = String.raw`none|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?`;

function components(body: string, percentOf = 1): number[] {
  return [...body.matchAll(new RegExp(COMPONENT, "gi"))].map(([text]) => {
    if (text.toLowerCase() === "none") return 0;
    return text.endsWith("%") ? (parseFloat(text) / 100) * percentOf : parseFloat(text);
  });
}

function alphaOf(body: string): number {
  const slash = body.split("/")[1];
  if (slash !== undefined) return components(slash)[0] ?? 1;
  return 1;
}

function encodeSrgb(linear: number): number {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, v * 255));
}

function fromLinear(r: number, g: number, b: number): Rgb {
  return { r: encodeSrgb(r), g: encodeSrgb(g), b: encodeSrgb(b) };
}

function oklabToRgb(L: number, A: number, B: number): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return fromLinear(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  );
}

const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labToRgb(L: number, A: number, B: number): Rgb {
  const fy = (L + 16) / 116;
  const fx = fy + A / 500;
  const fz = fy - B / 200;
  const inverse = (f: number) => (f ** 3 > LAB_EPSILON ? f ** 3 : (116 * f - 16) / LAB_KAPPA);
  const x = inverse(fx) * D50_WHITE[0];
  const y = (L > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : L / LAB_KAPPA) * D50_WHITE[1];
  const z = inverse(fz) * D50_WHITE[2];

  const X = 0.955473421488075 * x - 0.02309845494876471 * y + 0.06325924320057072 * z;
  const Y = -0.0283697093338637 * x + 1.0099953980813041 * y + 0.021041441191917323 * z;
  const Z = 0.012314014864481998 * x - 0.020507649298898964 * y + 1.330365926242124 * z;

  return fromLinear(
    3.2409699419045226 * X - 1.537383177570094 * Y - 0.4986107602930034 * Z,
    -0.9692436362808796 * X + 1.8759675015077202 * Y + 0.04155505740717559 * Z,
    0.05563007969699366 * X - 0.20397695888897652 * Y + 1.0569715142428786 * Z
  );
}

const polar = (C: number, H: number) => {
  const h = (H * Math.PI) / 180;
  return [C * Math.cos(h), C * Math.sin(h)] as const;
};

export function parseCssColour(value: string): Rgba {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const fn = /^([a-z]+)\((.*)\)$/.exec(text);
  if (!fn) throw new Error(`not a computed colour: ${value}`);
  const [, name, body] = fn;
  const [head] = body.split("/");

  if (name === "rgb" || name === "rgba") {
    const [r, g, b, legacyAlpha] = components(head, 255);
    const a = body.includes("/") ? alphaOf(body) : (legacyAlpha ?? 1);
    return { r, g, b, a };
  }
  if (name === "color" && head.trim().startsWith("srgb")) {
    const [r, g, b] = components(head.trim().slice(4));
    return { r: r * 255, g: g * 255, b: b * 255, a: alphaOf(body) };
  }
  if (name === "oklab") {
    const [L, A, B] = components(head);
    return { ...oklabToRgb(L, A, B), a: alphaOf(body) };
  }
  if (name === "oklch") {
    const [L, C, H] = components(head);
    return { ...oklabToRgb(L, ...polar(C, H)), a: alphaOf(body) };
  }
  if (name === "lab") {
    const [L, A, B] = components(head, 100);
    return { ...labToRgb(L, A, B), a: alphaOf(body) };
  }
  if (name === "lch") {
    const [L, C, H] = components(head, 100);
    return { ...labToRgb(L, ...polar(C, H)), a: alphaOf(body) };
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
