import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { MENTION, replaceMentions } from "@/lib/mentions";

const parser = unified().use(remarkParse).use(remarkGfm);

// Hundreds of nesting levels, or thousands of emphasis markers, cost the parser seconds and then its
// stack (BP-1107). A body past either is read as raw text, as it was before the parse: a mention in
// its code or links is told, and one in emphasis is not
const DEEPLY_NESTED = /^[ \t>*+\-]{500,}/m;
const MOST_EMPHASIS_MARKERS = 5000;

function tooCostlyToParse(markdown: string): boolean {
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

function readRawText(markdown: string, found: Set<string>) {
  for (const match of markdown.matchAll(new RegExp(MENTION, "g"))) found.add(match[1].toLowerCase());
}

/** Who a comment mentions, read from the same markdown tree the reader is shown. */
export function mentionedUsernames(markdown: string): string[] {
  const found = new Set<string>();
  if (tooCostlyToParse(markdown)) {
    readRawText(markdown, found);
    return [...found];
  }
  try {
    replaceMentions(parser.parse(markdown), (_whole, username) => {
      found.add(username.toLowerCase());
      return false;
    });
  } catch {
    readRawText(markdown, found);
  }
  return [...found];
}
