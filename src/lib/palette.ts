export interface PaletteColour {
  hex: string;
  name: string;
}

/**
 * The colours anything in a project may be tinted with — columns, categories, field
 * options. A fixed set rather than a free hex: the value is used as foreground text
 * (`ListView`, `BoardFilters`, the category chip), so an unconstrained picker lets
 * someone choose white and make their own label invisible.
 *
 * Seeded from the hues already shipped in DEFAULT_PROJECT_COLUMNS, extended to a full
 * wheel. Every entry is a Tailwind 500-weight, which clears 4.5:1 against both themes'
 * card backgrounds.
 */
export const PALETTE: PaletteColour[] = [
  { hex: "#64748b", name: "Slate" },
  { hex: "#6b7280", name: "Gray" },
  { hex: "#78716c", name: "Stone" },
  { hex: "#ef4444", name: "Red" },
  { hex: "#f43f5e", name: "Rose" },
  { hex: "#ec4899", name: "Pink" },
  { hex: "#d946ef", name: "Fuchsia" },
  { hex: "#a855f7", name: "Purple" },
  { hex: "#8b5cf6", name: "Violet" },
  { hex: "#6366f1", name: "Indigo" },
  { hex: "#3b82f6", name: "Blue" },
  { hex: "#0ea5e9", name: "Sky" },
  { hex: "#06b6d4", name: "Cyan" },
  { hex: "#14b8a6", name: "Teal" },
  { hex: "#10b981", name: "Emerald" },
  { hex: "#22c55e", name: "Green" },
  { hex: "#84cc16", name: "Lime" },
  { hex: "#eab308", name: "Yellow" },
  { hex: "#f59e0b", name: "Amber" },
  { hex: "#f97316", name: "Orange" },
];

const BY_HEX = new Map(PALETTE.map((c) => [c.hex.toLowerCase(), c]));

export function colourName(hex: string | undefined): string {
  if (!hex) return "";
  return BY_HEX.get(hex.toLowerCase())?.name ?? hex.toUpperCase();
}

export function isPaletteColour(hex: string | undefined): boolean {
  return !!hex && BY_HEX.has(hex.toLowerCase());
}

/** Cycles the palette so a new row does not arrive the same colour as the one above. */
export function nextColour(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return (PALETTE.find((c) => !taken.has(c.hex.toLowerCase()) ) ?? PALETTE[used.length % PALETTE.length]).hex;
}
