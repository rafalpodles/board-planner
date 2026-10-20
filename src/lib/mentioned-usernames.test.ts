import { describe, expect, it } from "vitest";
import { MENTION_BEING_TYPED } from "./mentions";
import { mentionedUsernames } from "./mentioned-usernames";

describe("mentionedUsernames", () => {
  it("reads every username once, lower-cased", () => {
    expect(mentionedUsernames("@Rafal and @member, then @rafal again")).toEqual(["rafal", "member"]);
  });

  it("keeps the dots a username may hold and drops the one that ends a sentence", () => {
    expect(mentionedUsernames("ask @jan.kowalski. Or @a.b-c_d!")).toEqual(["jan.kowalski", "a.b-c_d"]);
  });

  it("does not read the domain of an e-mail address as a mention", () => {
    expect(mentionedUsernames("write to ops@member.example or me@rafal")).toEqual([]);
  });

  // What the reader sees highlighted is who is told: the prose, after the markdown is read
  it("reads a mention inside emphasis, and none in code or a link", () => {
    expect(mentionedUsernames("_@member_ and __@rafal__, not `@code` nor [@link](https://example.com)\n\n```\n@block\n```")).toEqual([
      "member",
      "rafal",
    ]);
  });

  it("reads a mention after punctuation and at the start of a line", () => {
    expect(mentionedUsernames("(@member)\n@rafal: yes")).toEqual(["member", "rafal"]);
  });
});

describe("a body nested deeper than the markdown parser can follow", () => {
  // Inside the comment limit, and enough to exhaust the parser's stack (BP-1107). The comment is
  // already stored when its mentions are read, so a throw here answered 500 for a saved comment
  it.each([
    [">".repeat(6000), "blockquotes"],
    ["- ".repeat(3000), "list items"],
  ])("still reads its mentions from the text, through %s deep %s", (prefix) => {
    expect(mentionedUsernames(`${prefix}@member look`)).toEqual(["member"]);
  });
});

describe("MENTION_BEING_TYPED", () => {
  const typed = (before: string) => before.match(MENTION_BEING_TYPED)?.[1] ?? null;

  it("offers from a bare @ and through a dot", () => {
    expect(typed("hi @")).toBe("");
    expect(typed("hi @jan.")).toBe("jan.");
  });

  it("does not open inside an e-mail address", () => {
    expect(typed("ops@mem")).toBeNull();
  });
});
