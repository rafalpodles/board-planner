import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { MENTION, replaceMentions } from "@/lib/mentions";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Who a comment mentions, read from the same markdown tree the reader is shown. */
export function mentionedUsernames(markdown: string): string[] {
  const found = new Set<string>();
  try {
    replaceMentions(parser.parse(markdown), (_whole, username) => {
      found.add(username.toLowerCase());
      return false;
    });
  } catch {
    // Nesting deep enough to exhaust the parser's stack (BP-1107): read the raw text instead
    for (const match of markdown.matchAll(new RegExp(MENTION, "g"))) found.add(match[1].toLowerCase());
  }
  return [...found];
}
