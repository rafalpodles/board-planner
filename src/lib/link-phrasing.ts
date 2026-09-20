import { LinkDirection } from "@/types";

/**
 * One sentence for a link that appeared or went away, read from one end of it.
 *
 * Shared by the server, which writes it into a notification title where both ends have to be
 * named, and by the timeline, which renders it under a task that is already on screen and passes
 * "this task" as `self`. Two spellings of the same event drift; one cannot.
 *
 * `actor` is the caller's, and the two callers do differ: the timeline has the row's populated
 * user and reads `fullName`, the notification has only an id and reads `username`. Only one other
 * notification title in this app names an actor at all — `mentioned` — and it names a username,
 * so this follows it rather than being made uniform here.
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
    // `field` on an activity row is an unconstrained string, so the timeline's cast is a promise
    // the schema does not keep. Every other action in that switch degrades to a sentence rather
    // than to a blank row; this one has to as well.
    //
    // The `never` keeps what a bare default would have given away: a direction added to the union
    // and not handled above is still a compile error rather than quietly taking this branch.
    default: {
      const unhandled: never = direction;
      void unhandled;
      // Deliberately NOT the `relates` sentence, which this used to borrow: a row whose direction
      // cannot be read is no evidence that the relation was that one, and naming a type here would
      // invent the very fact the row failed to carry.
      return added
        ? `${actor} added a dependency between ${self} and ${other}`
        : `${actor} removed a dependency between ${self} and ${other}`;
    }
  }
}
