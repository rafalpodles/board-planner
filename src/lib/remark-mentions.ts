import type { Root } from "mdast";
import { replaceMentions } from "@/lib/mentions";

export interface MentionablePerson {
  username: string;
  fullName: string;
}

/**
 * Turns `@username` into a pill for the people this board can mention, and leaves any other `@word`
 * as the text it was.
 */
export function remarkMentions(people: readonly MentionablePerson[]) {
  const byUsername = new Map(
    people.filter((p) => typeof p.username === "string").map((p) => [p.username.toLowerCase(), p])
  );

  return () => (tree: Root) => {
    if (byUsername.size === 0) return;

    replaceMentions(tree, (whole, username) => {
      const person = byUsername.get(username.toLowerCase());
      if (!person) return false;

      return {
        type: "strong",
        data: {
          hName: "span",
          hProperties: { className: ["mention"], title: person.fullName || person.username },
        },
        children: [{ type: "text", value: whole }],
      };
    });
  };
}
