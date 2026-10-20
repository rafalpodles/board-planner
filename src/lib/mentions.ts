// A username may hold dots (USERNAME_PATTERN), but a sentence may end right after one, so a dot
// counts only when another name character follows it. The lookbehind keeps the domain of an e-mail
// address from reading as a mention of whoever is called that.
const NAME = "[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\\.(?=[a-zA-Z0-9_-]))*";
const NOT_INSIDE_A_WORD = "(?<![\\w.@-])";

export const MENTION = new RegExp(`${NOT_INSIDE_A_WORD}@(${NAME})`, "g");

/** What the composer matches before the caret: the mention being typed, possibly still empty. */
export const MENTION_BEING_TYPED = new RegExp(`${NOT_INSIDE_A_WORD}@([a-zA-Z0-9._-]*)$`);

export function mentionedUsernames(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))];
}
