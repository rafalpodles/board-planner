// Hundreds of nesting levels, or thousands of emphasis markers, cost the markdown parser seconds and
// then its stack (BP-1107). A body past either is not parsed: the server reads its mentions from the
// raw text, and the reader shows it as text. The limits sit well above anything written to be read —
// a long paste of code, table borders and bullets stays under them — and well below what stalls.
const DEEPLY_NESTED = /^[ \t>*+\-\d.)]{500,}/m;
const MOST_EMPHASIS_MARKERS = 5000;

export function tooCostlyToParse(markdown: string): boolean {
  if (DEEPLY_NESTED.test(markdown)) return true;
  let markers = 0;
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown[i];
    if (char !== "*" && char !== "_") continue;
    // snake_case and __dunder__ names: an underscore between two word characters emphasises nothing
    if (char === "_" && /\w/.test(markdown[i - 1] ?? "") && /\w/.test(markdown[i + 1] ?? "")) continue;
    if (++markers > MOST_EMPHASIS_MARKERS) return true;
  }
  return false;
}
