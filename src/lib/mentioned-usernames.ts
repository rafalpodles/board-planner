import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { MENTION, replaceMentions } from "@/lib/mentions";

const parser = unified().use(remarkParse).use(remarkGfm);

// Deep nesting and long runs of emphasis markers cost the parser seconds, then its stack (BP-1107);
// no comment written to be read goes near either
const DEEPLY_NESTED = /^[ \t>*+\-\d.)]{100,}/m;
const MOST_EMPHASIS_MARKERS = 1000;

function tooCostlyToParse(markdown: string): boolean {
  if (DEEPLY_NESTED.test(markdown)) return true;
  let markers = 0;
  for (const char of markdown) if ((char === "*" || char === "_") && ++markers > MOST_EMPHASIS_MARKERS) return true;
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
