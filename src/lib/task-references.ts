import { findAndReplace } from "mdast-util-find-and-replace";
import type { Root } from "mdast";
import { taskPath } from "@/lib/urls";

const REFERENCE = /(^|[^\w-])([A-Za-z][A-Za-z0-9_-]{0,19})-(\d{1,9})(?![\w-])/g;

export interface ReferenceScope {
  key: string;
  formerKeys?: string[];
}

export function keyBelongsTo(candidate: string, scope: ReferenceScope | null | undefined): boolean {
  if (!scope) return false;
  const wanted = candidate.toLowerCase();
  return (
    scope.key.toLowerCase() === wanted ||
    (scope.formerKeys ?? []).some((k) => k.toLowerCase() === wanted)
  );
}

export function remarkTaskReferences(scope: ReferenceScope | null | undefined) {
  return () => (tree: Root) => {
    if (!scope?.key) return;

    findAndReplace(
      tree,
      [
        [
          REFERENCE,
          (_full: string, before: string, key: string, number: string) => {
            if (!keyBelongsTo(key, scope)) return false;

            return [
              { type: "text", value: before },
              {
                type: "link",
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
