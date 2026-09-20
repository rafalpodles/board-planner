import { LinkDirection } from "@/types";

/**
 * One sentence for a link that appeared or went away, read from one end of it.
 *
 * Shared by the server, which writes it into a notification title where both ends have to be
 * named, and by the timeline, which renders it under a task that is already on screen and passes
 * "this task" as `self`. Two spellings of the same event drift; one cannot.
 */
export function describeLinkChange({
  actor,
  action,
  direction,
  self,
  other,
}: {
  actor: string;
  action: "added" | "removed";
  direction: LinkDirection;
  self: string;
  other: string;
}): string {
  const added = action === "added";

  switch (direction) {
    case "blocked_by":
      return added
        ? `${actor} marked ${self} as blocked by ${other}`
        : `${actor} removed ${other} as a blocker of ${self}`;
    case "blocks":
      return added
        ? `${actor} marked ${other} as blocked by ${self}`
        : `${actor} removed ${self} as a blocker of ${other}`;
    case "relates":
      return added ? `${actor} linked ${self} to ${other}` : `${actor} unlinked ${self} from ${other}`;
    case "duplicates":
      return added
        ? `${actor} marked ${self} as a duplicate of ${other}`
        : `${actor} removed ${self} as a duplicate of ${other}`;
    case "duplicated_by":
      return added
        ? `${actor} marked ${other} as a duplicate of ${self}`
        : `${actor} removed ${other} as a duplicate of ${self}`;
    case "parent_of":
      return added
        ? `${actor} made ${self} the parent of ${other}`
        : `${actor} removed ${other} from ${self}'s children`;
    case "child_of":
      return added
        ? `${actor} made ${other} the parent of ${self}`
        : `${actor} removed ${self} from ${other}'s children`;
  }
}
