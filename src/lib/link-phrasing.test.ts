import { describe, it, expect } from "vitest";
import { LinkDirection } from "@/types";
import { describeLinkChange } from "./link-phrasing";

/**
 * Every sentence a person reads about a link, in both substitutions it is written for: the
 * timeline, which is already on the task and passes "this task", and a notification, which is not
 * and passes the key. Each one is here because a relation is stored on ONE of the two tasks, so
 * the other end's row is this function's only chance to say the same fact the right way round —
 * and a backwards sentence in somebody's history is the worst outcome this change can have.
 */
const say = (direction: LinkDirection, action: "added" | "removed", self: string, other: string) =>
  describeLinkChange({ actor: "rafal", action, direction, self, other });

describe("read from the task you are looking at", () => {
  const cases: [LinkDirection, "added" | "removed", string][] = [
    ["blocked_by", "added", "rafal marked this task as blocked by BP-9"],
    ["blocked_by", "removed", "rafal removed BP-9 as a blocker of this task"],
    ["blocks", "added", "rafal marked BP-9 as blocked by this task"],
    ["blocks", "removed", "rafal removed this task as a blocker of BP-9"],
    ["relates", "added", "rafal linked this task to BP-9"],
    ["relates", "removed", "rafal unlinked this task from BP-9"],
    ["duplicates", "added", "rafal marked this task as a duplicate of BP-9"],
    ["duplicates", "removed", "rafal removed this task as a duplicate of BP-9"],
    ["duplicated_by", "added", "rafal marked BP-9 as a duplicate of this task"],
    ["duplicated_by", "removed", "rafal removed BP-9 as a duplicate of this task"],
    ["parent_of", "added", "rafal made this task the parent of BP-9"],
    ["parent_of", "removed", "rafal removed BP-9 from this task's children"],
    ["child_of", "added", "rafal made BP-9 the parent of this task"],
    ["child_of", "removed", "rafal removed this task from BP-9's children"],
  ];

  for (const [direction, action, expected] of cases) {
    it(`${direction} ${action}: ${expected}`, () => {
      expect(say(direction, action, "this task", "BP-9")).toBe(expected);
    });
  }
});

describe("read where neither end is on screen", () => {
  it("names both tasks when the sentence is a notification title", () => {
    expect(say("parent_of", "added", "BP-3", "BP-9")).toBe("rafal made BP-3 the parent of BP-9");
    expect(say("child_of", "removed", "BP-3", "BP-9")).toBe(
      "rafal removed BP-3 from BP-9's children"
    );
  });

  // taskKeyOf falls back to #42 for a task whose project cannot be resolved
  it("reads with the fallback key a deleted board leaves behind", () => {
    expect(say("relates", "added", "#42", "#7")).toBe("rafal linked #42 to #7");
  });
});

describe("the two ends of one write", () => {
  // The property that matters: A's row and B's row are the same fact, not two different ones.
  it("says the same thing from either side of a parent link", () => {
    expect(say("parent_of", "added", "BP-3", "BP-9")).toBe("rafal made BP-3 the parent of BP-9");
    expect(say("child_of", "added", "BP-9", "BP-3")).toBe("rafal made BP-3 the parent of BP-9");
  });

  it("says the same thing from either side of a blocker", () => {
    expect(say("blocked_by", "added", "BP-3", "BP-9")).toBe(
      "rafal marked BP-3 as blocked by BP-9"
    );
    expect(say("blocks", "added", "BP-9", "BP-3")).toBe("rafal marked BP-3 as blocked by BP-9");
  });

  it("says the same thing from either side of a duplicate", () => {
    expect(say("duplicates", "added", "BP-3", "BP-9")).toBe(
      "rafal marked BP-3 as a duplicate of BP-9"
    );
    expect(say("duplicated_by", "added", "BP-9", "BP-3")).toBe(
      "rafal marked BP-3 as a duplicate of BP-9"
    );
  });

  it("is symmetric where the relation is", () => {
    expect(say("relates", "added", "BP-3", "BP-9")).toBe("rafal linked BP-3 to BP-9");
    expect(say("relates", "added", "BP-9", "BP-3")).toBe("rafal linked BP-9 to BP-3");
  });
});

describe("a direction it does not know", () => {
  // `field` on an activity row is an unconstrained string and the timeline casts it, so this is
  // reachable from stored data even though nothing writes it today. A blank row is worse than a
  // vague one: every other action in that switch degrades to a sentence.
  it("still says something rather than nothing", () => {
    expect(say("something_else" as LinkDirection, "added", "this task", "BP-9")).toBe(
      "rafal added a dependency between this task and BP-9"
    );
    expect(say("something_else" as LinkDirection, "removed", "this task", "BP-9")).toBe(
      "rafal removed a dependency between this task and BP-9"
    );
  });

  // And it must not borrow a type it has no evidence for. Reusing the `relates` wording made a
  // row whose direction could not be read indistinguishable from a real "relates" link.
  it("does not name a relation it cannot read", () => {
    const vague = say("something_else" as LinkDirection, "added", "this task", "BP-9");

    expect(vague).not.toBe(say("relates", "added", "this task", "BP-9"));
    for (const named of ["linked", "parent", "duplicate", "blocked"]) {
      expect(vague).not.toContain(named);
    }
  });
});
