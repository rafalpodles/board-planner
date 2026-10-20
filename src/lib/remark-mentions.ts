import { findAndReplace } from "mdast-util-find-and-replace";
import type { Root } from "mdast";
import { MENTION } from "@/lib/mentions";

export interface MentionablePerson {
  username: string;
  fullName: string;
}

/**
 * Turns `@username` into a pill for the people this board can mention, and leaves any other `@word`
 * as the text it was. A remark plugin for the reason `remarkTaskReferences` is one: code spans,
 * fenced blocks and links are out of its reach.
 */
export function remarkMentions(people: readonly MentionablePerson[]) {
  const byUsername = new Map(
    people.filter((p) => typeof p.username === "string").map((p) => [p.username.toLowerCase(), p])
  );

  return () => (tree: Root) => {
    if (byUsername.size === 0) return;

    findAndReplace(
      tree,
      [
        [
          new RegExp(MENTION.source, "g"),
          (whole: string, username: string) => {
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
          },
        ],
      ],
      { ignore: ["code", "inlineCode", "math", "inlineMath", "link", "linkReference", "definition"] }
    );
  };
}
