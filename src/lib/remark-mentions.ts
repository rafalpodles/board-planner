import type { Root } from "mdast";
import { replaceMentions } from "@/lib/mentions";

export interface MentionablePerson {
  username: string;
  fullName: string;
}

/**
 * Turns `@username` into a pill naming the person, for the people this board can mention, and
 * leaves any other `@word` as the text it was. The reader's own mentions get a pill of their own.
 */
export function remarkMentions(people: readonly MentionablePerson[], reader?: string) {
  const byUsername = new Map(
    people.filter((p) => typeof p.username === "string").map((p) => [p.username.toLowerCase(), p])
  );
  const readerKey = reader?.toLowerCase();

  return () => (tree: Root) => {
    if (byUsername.size === 0) return;

    replaceMentions(tree, (_whole, username) => {
      const person = byUsername.get(username.toLowerCase());
      if (!person) return false;

      const self = person.username.toLowerCase() === readerKey;
      return {
        type: "strong",
        data: {
          hName: "span",
          hProperties: {
            className: self ? ["mention", "mention-self"] : ["mention"],
            title: `@${person.username}`,
          },
        },
        children: [{ type: "text", value: `@${person.fullName?.trim() || person.username}` }],
      };
    });
  };
}
