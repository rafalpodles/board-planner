import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { MENTION, replaceMentions } from "@/lib/mentions";
import { tooCostlyToParse } from "@/lib/markdown-cost";

const parser = unified().use(remarkParse).use(remarkGfm);

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
