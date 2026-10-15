import { describe, it, expect } from "vitest";
import { jiraWikiToMarkdown } from "./jira-wiki";

describe("jiraWikiToMarkdown", () => {
  it("turns Jira's headings, monospace, emphasis, lists and links into Markdown", () => {
    const wiki = [
      "h2. Context",
      "The {{OrderRepository}} has *six* methods and an _optional_ cache, -not- ten.",
      "* first",
      "** nested",
      "# numbered",
      "See [the guide|https://example.com/guide] or [https://example.com].",
      "bq. Quoted",
    ].join("\n");
    expect(jiraWikiToMarkdown(wiki)).toBe(
      [
        "## Context",
        "The `OrderRepository` has **six** methods and an *optional* cache, ~~not~~ ten.",
        "- first",
        "  - nested",
        "1. numbered",
        "See [the guide](https://example.com/guide) or https://example.com.",
        "> Quoted",
      ].join("\n")
    );
  });

  it("keeps code blocks as they are, and closes one the text never closed", () => {
    expect(jiraWikiToMarkdown("{code:java}\nint *a* = {{b}};\n{code}\nafter")).toBe("```java\nint *a* = {{b}};\n```\nafter");
    expect(jiraWikiToMarkdown("{noformat}raw *x*{noformat}")).toBe("```\nraw *x*\n```");
    expect(jiraWikiToMarkdown("{code}\nopen")).toBe("```\nopen\n```");
  });

  it("names a mention, and reads Jira's double dash as text, not a nested list", () => {
    expect(jiraWikiToMarkdown("[~accountid:557058:abc] and [~jan]\n-- Jan")).toBe("@557058:abc and @jan\n-- Jan");
  });

  it("reads a line of bold text as bold, not as a list item", () => {
    expect(jiraWikiToMarkdown("*Important* note")).toBe("**Important** note");
  });
});
