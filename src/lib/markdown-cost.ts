// The markdown parser is quadratic in the shape of the body, and throws out of its own stack when
// nesting runs deep (BP-1107): 6,000 `>` stall a tab for seconds and then crash the page. A body
// past any limit here is not parsed; it is read and shown as text.
const MOST_PARSED_CHARS = 20_000;
const MOST_EMPHASIS_MARKERS = 2_000;
const MOST_LAZY_LINES = 500;
const NESTING_TOKENS = 40;

// A run of container markers (`>`, `-`, `*`, `+`, `1.`) at the start of a line
const DEEPLY_NESTED = new RegExp(
  `^(?:[ \\t]*(?:>|[-*+](?=[ \\t])|\\d{1,9}[.)](?=[ \\t]))){${NESTING_TOKENS},}`,
  "m"
);
const CONTAINER_LINE = /^[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])/;

export function tooCostlyToParse(markdown: string): boolean {
  if (markdown.length > MOST_PARSED_CHARS || DEEPLY_NESTED.test(markdown)) return true;

  let markers = 0;
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown[i];
    if (char !== "*" && char !== "_") continue;
    // snake_case and __dunder__ names: an underscore between two word characters emphasises nothing
    if (char === "_" && /\w/.test(markdown[i - 1] ?? "") && /\w/.test(markdown[i + 1] ?? "")) continue;
    if (++markers > MOST_EMPHASIS_MARKERS) return true;
  }

  // Lines that continue a quote or list item without repeating its marker
  let inContainer = false;
  let lazy = 0;
  for (const line of markdown.split("\n")) {
    if (!line.trim()) {
      inContainer = false;
      lazy = 0;
    } else if (CONTAINER_LINE.test(line)) {
      inContainer = true;
    } else if (inContainer && ++lazy > MOST_LAZY_LINES) {
      return true;
    }
  }
  return false;
}
