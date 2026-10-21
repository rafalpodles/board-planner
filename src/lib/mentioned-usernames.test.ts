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
  // Inside the comment limit. Each costs the parser seconds and then its stack (BP-1107), on a comment
  // already stored: a throw answered 500 for it, and the wait held up every other request
  it.each([
    [">".repeat(15000), "blockquotes"],
    ["- ".repeat(7500), "list items"],
    ["_*".repeat(10000), "emphasis markers"],
  ])("reads its mentions from the text, at once, through %s deep %s", (prefix) => {
    const started = performance.now();
    expect(mentionedUsernames(`${prefix}@member look`)).toEqual(["member"]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // The guard reads the raw text, which a fence does not hide; the parse it skips would have
  it("still parses an ordinary comment, so a mention in code is not told", () => {
    expect(mentionedUsernames(`${"- ".repeat(20)}item\n\n\`@member\``)).toEqual([]);
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
