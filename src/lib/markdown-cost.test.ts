import { describe, expect, it } from "vitest";
import { tooCostlyToParse } from "./markdown-cost";

const repeat = (text: string, chars: number) => text.repeat(Math.ceil(chars / text.length)).slice(0, chars);

describe("a body too costly to parse (BP-1107)", () => {
  it.each([
    ["blockquotes", ">".repeat(6000)],
    ["spaced blockquotes", "> ".repeat(5451)],
    ["list items", "- ".repeat(7500)],
    ["numbered list items", "1. ".repeat(6600)],
    ["nested numbered quotes", "> 1. ".repeat(4000)],
    ["a nested list on every line", repeat(`${"- ".repeat(41)}x\n`, 19000)],
    ["emphasis markers", "_*".repeat(10000)],
    ["stars between words", "*a".repeat(10000)],
    ["nested emphasis", `${"*a ".repeat(2499)}c${" a*".repeat(2499)}`],
    ["a quote whose lines do not repeat its marker", `> ${repeat("a\n", 8000)}`],
    ["a list item whose lines do not repeat its marker", `- ${repeat("a\n", 8000)}`],
    ["more than the longest comment", "word ".repeat(4001)],
  ])("is flagged for %s", (_label, body) => {
    expect(tooCostlyToParse(`${body}x`)).toBe(true);
  });

  it("finds the nesting on any line, not only the first", () => {
    expect(tooCostlyToParse(`a comment\n\n${">".repeat(600)} deep`)).toBe(true);
  });

  it("counts a quote's lazy lines until a blank line ends the paragraph", () => {
    const lazy = repeat("a\n", 1200);
    expect(tooCostlyToParse(`> quote\n${lazy}`)).toBe(true);
    expect(tooCostlyToParse(`> quote\n\n${lazy}`)).toBe(false);
  });

  it.each([
    ["prose", "word ".repeat(3000)],
    ["a table border of dashes", `+${"-".repeat(300)}+`],
    ["a modest nested list", "- ".repeat(39)],
    ["a quoted e-mail reply", repeat("> a quoted line of the reply\n", 19000)],
    ["many short quotes, each continued lazily", repeat("> quote\nlazy one\nlazy two\nlazy three\n\n", 19000)],
    ["a long bullet list", repeat("- an item in a long list\n", 19000)],
    ["a paste of Python", repeat("    def get(self, user_id, *args, **kwargs):\n        return self.__cache[user_id]\n", 19000)],
    ["snake_case names, thousands of underscores", "get_user_by_id ".repeat(1300)],
    [
      "a document of headings, links and code",
      repeat("## Heading\n\nSome **bold** text with a [link](https://x.com) and `code`.\n\n- one\n- two\n\n", 19000),
    ],
  ])("is not flagged for %s", (_label, body) => {
    expect(tooCostlyToParse(body)).toBe(false);
  });
});
