import { findAndReplace, type ReplaceFunction } from "mdast-util-find-and-replace";
import type { Root } from "mdast";

// A username may hold dots (USERNAME_PATTERN), but a sentence may end right after one, so a dot
// counts only when another name character follows it. A username ending in a dot, or holding two
// in a row, is therefore read short. The lookbehind keeps an e-mail address from reading as a
// mention of whoever has the name after its @.
const NAME = "[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\\.(?=[a-zA-Z0-9_-]))*";
const NOT_INSIDE_A_WORD = "(?<![\\w.@-])";

export const MENTION = `${NOT_INSIDE_A_WORD}@(${NAME})`;

/** What the composer matches before the caret: the mention being typed, possibly still empty. */
export const MENTION_BEING_TYPED = new RegExp(`${NOT_INSIDE_A_WORD}@([a-zA-Z0-9._-]*)$`);

/**
 * Every mention in a markdown tree's prose. Code, links and definitions are out of reach, so what
 * the reader sees highlighted and who is told are the same people.
 */
export function replaceMentions(tree: Root, replace: (whole: string, username: string) => ReturnType<ReplaceFunction>) {
  findAndReplace(tree, [[new RegExp(MENTION, "g"), replace]], {
    ignore: ["code", "inlineCode", "math", "inlineMath", "link", "linkReference", "definition"],
  });
}
