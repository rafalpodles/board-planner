import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { remarkTaskReferences, keyBelongsTo } from "./task-references";

const SCOPE = { key: "BP", formerKeys: ["CP"] };

function render(markdown: string, scope: typeof SCOPE | null = SCOPE): string {
  return unified()
    .use(remarkParse)
    .use(remarkTaskReferences(scope))
    .use(remarkStringify)
    .processSync(markdown)
    .toString()
    .trim();
}

describe("linking task references written in prose", () => {
  it("links a key on this board", () => {
    expect(render("see BP-12 for the rest")).toContain("[BP-12](/projects/BP/tasks/12)");
  });

  it("links a key the board used to answer to, at its current address", () => {
    expect(render("originally CP-5")).toContain("[CP-5](/projects/BP/tasks/5)");
  });

  it("leaves another project's key as plain text", () => {
    const out = render("blocked by ACME-7");
    expect(out).not.toContain("](");
    expect(out).toContain("ACME-7");
  });

  it("does nothing when the content belongs to no board", () => {
    expect(render("see BP-12", null)).not.toContain("](");
  });
});

describe("what must not be turned into a link", () => {
  it("leaves a key inside a code span alone", () => {
    expect(render("`BP-12` is the branch prefix")).not.toContain("](/projects");
  });

  it("leaves a key inside a fenced block alone", () => {
    expect(render("```\ngit checkout bp-12/slug BP-12\n```")).not.toContain("](/projects");
  });

  it("does not nest a link inside an existing one", () => {
    const out = render("[BP-12](https://example.com/elsewhere)");
    expect(out).toContain("https://example.com/elsewhere");
    expect(out).not.toContain("/projects/BP/tasks/12");
  });

  it("does not touch a key that is part of a longer identifier", () => {
    expect(render("commit abc-BP-3 was it")).not.toContain("](/projects");
  });

  it("does not link a bare number or a key with none", () => {
    expect(render("BP- and 12 and BP")).not.toContain("](/projects");
  });
});

describe("where the match starts and stops", () => {
  it("links a reference at the very start of the text", () => {
    expect(render("BP-3 is done")).toContain("[BP-3](/projects/BP/tasks/3)");
  });

  it("links one followed by punctuation", () => {
    expect(render("done in BP-3.")).toContain("[BP-3](/projects/BP/tasks/3)");
  });

  it("takes the whole number, not a prefix of it", () => {
    expect(render("see BP-12")).toContain("/projects/BP/tasks/12");
    expect(render("see BP-12")).not.toContain("/projects/BP/tasks/1)");
  });

  it("does not link a key whose number runs into something else", () => {
    expect(render("release BP-12beta shipped")).not.toContain("](/projects");
    expect(render("range BP-12-14")).not.toContain("](/projects");
  });

  it("links several references in one paragraph", () => {
    const out = render("BP-1 then BP-2");
    expect(out).toContain("/projects/BP/tasks/1)");
    expect(out).toContain("/projects/BP/tasks/2)");
  });

  it("matches the key case-insensitively, like every other key comparison here", () => {
    expect(render("see bp-12")).toContain("[bp-12](/projects/BP/tasks/12)");
  });
});

describe("keyBelongsTo", () => {
  it("accepts the current key and the former ones, whatever their case", () => {
    expect(keyBelongsTo("bp", SCOPE)).toBe(true);
    expect(keyBelongsTo("CP", SCOPE)).toBe(true);
    expect(keyBelongsTo("acme", SCOPE)).toBe(false);
    expect(keyBelongsTo("BP", null)).toBe(false);
  });
});
