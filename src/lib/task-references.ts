import { findAndReplace } from "mdast-util-find-and-replace";
import type { Root } from "mdast";
import { taskPath } from "@/lib/urls";

// A key is a project key and a number. Bounded on the left by a non-word character so an id like
// `SHA-1` inside `abc-BP-3` is not a reference, and on the right by a digit boundary so BP-1 does
// not swallow the 2 of BP-12.
const REFERENCE = /(^|[^\w-])([A-Za-z][A-Za-z0-9_-]{0,19})-(\d{1,9})(?![\w-])/g;

export interface ReferenceScope {
  /** The key this board answers to today. */
  key: string;
  /**
   * Keys it used to answer to. A project keeps them (see Project.formerKeys) because renaming it
   * renames every task key at once, while the text people already wrote keeps the old prefix —
   * this repo's own history is full of CP-… and lives on a board keyed BP.
   */
  formerKeys?: string[];
}

/** Case-insensitive, like every other key comparison in this codebase. */
export function keyBelongsTo(candidate: string, scope: ReferenceScope | null | undefined): boolean {
  if (!scope) return false;
  const wanted = candidate.toLowerCase();
  return (
    scope.key.toLowerCase() === wanted ||
    (scope.formerKeys ?? []).some((k) => k.toLowerCase() === wanted)
  );
}

/**
 * Turns `BP-12` written in ordinary prose into a link to that task.
 *
 * Deliberately a remark plugin rather than a string replacement on the source. `findAndReplace`
 * walks mdast text nodes, so a code span, a fenced block and a link destination are structurally
 * out of reach — none of which a regex over the raw markdown can tell apart. The `@mention`
 * rendering next to this is that regex, and it bolds the `@` of an email address.
 *
 * It does reach the text *inside* an existing link, though, which would nest one link in another
 * and render as neither. `ignore` has to say so; the defaults it replaces are restated with it.
 *
 * Nothing is stored as a link: the text keeps saying `BP-12`. That matters because this project has
 * already renamed its key once, and a URL baked into every description would have needed migrating
 * along with it.
 */
export function remarkTaskReferences(scope: ReferenceScope | null | undefined) {
  return () => (tree: Root) => {
    if (!scope?.key) return;

    findAndReplace(
      tree,
      [
        [
          REFERENCE,
          (_full: string, before: string, key: string, number: string) => {
            // Only this board's keys. A reference to a project the reader may not be able to open
            // is a product decision about visibility, not a rendering one, and stays plain text.
            if (!keyBelongsTo(key, scope)) return false;

            return [
              { type: "text", value: before },
              {
                type: "link",
                // Always today's key: the link has to reach the task, and a former key is only a
                // way of recognising what somebody wrote
                url: taskPath(scope.key, number),
                children: [{ type: "text", value: `${key}-${number}` }],
              },
            ];
          },
        ],
      ],
      { ignore: ["code", "inlineCode", "math", "inlineMath", "link", "linkReference", "definition"] }
    );
  };
}
