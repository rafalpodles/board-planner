import type { Root } from "mdast";
import { replaceMentions } from "@/lib/mentions";
import { nameOf, peopleByUsername, type MentionablePerson } from "@/lib/mention-names";

export type { MentionablePerson } from "@/lib/mention-names";

/**
 * Turns `@username` into a pill naming the person, for the people this board can mention, and
 * leaves any other `@word` as the text it was. The reader's own mentions get a pill of their own.
 */
export function remarkMentions(people: readonly MentionablePerson[], reader?: string) {
  const byUsername = peopleByUsername(people);
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
            "data-username": person.username,
          },
        },
        children: [{ type: "text", value: `@${nameOf(person)}` }],
      };
    });
  };
}
