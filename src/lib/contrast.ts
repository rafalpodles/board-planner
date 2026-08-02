export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

// Matches CSS `color-mix(in srgb, a <pct>%, b)`
export function mix(a: Rgb, b: Rgb, pct: number): Rgb {
  const w = pct / 100;
  return {
    r: a.r * w + b.r * (1 - w),
    g: a.g * w + b.g * (1 - w),
    b: a.b * w + b.b * (1 - w),
  };
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export const CHIP_SURFACE_PCT = 18;
export const CHIP_LABEL_PCT = 55;

// The `.chip` rule in globals.css, evaluated in TypeScript so it can be asserted
export function chipContrast(accent: Rgb, cardBg: Rgb, text: Rgb): number {
  return contrastRatio(mix(accent, text, CHIP_LABEL_PCT), mix(accent, cardBg, CHIP_SURFACE_PCT));
}
