import { describe, expect, it } from "vitest";
import { tooCostlyToParse } from "./markdown-cost";

describe("a body too costly to parse (BP-1107)", () => {
  it.each([
    ["blockquotes", ">".repeat(6000)],
    ["spaced blockquotes", "> ".repeat(5451)],
    ["list items", "- ".repeat(7500)],
    ["numbered list items", "1. ".repeat(6600)],
    ["nested numbered quotes", "> 1. ".repeat(4000)],
    ["emphasis markers", "_*".repeat(10000)],
    ["stars between words", "*a".repeat(10000)],
  ])("is flagged for %s", (_label, body) => {
    expect(tooCostlyToParse(`${body}x`)).toBe(true);
  });

  it("finds the nesting on any line, not only the first", () => {
    expect(tooCostlyToParse(`a comment\n\n${">".repeat(600)} deep`)).toBe(true);
  });

  it.each([
    ["prose", "word ".repeat(3000)],
    ["a table border of dashes", `+${"-".repeat(300)}+`],
    ["a modest nested list", "- ".repeat(40)],
    ["snake_case and dunder names", "self.__cache[user_id] = get_user_by_id(user_id) ".repeat(300)],
    ["a few hundred bullets and bold", "* **one**\n* _two_\n".repeat(250)],
  ])("is not flagged for %s", (_label, body) => {
    expect(tooCostlyToParse(body)).toBe(false);
  });
});
