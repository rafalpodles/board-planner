import { describe, it, expect } from "vitest";
import { escapeSlack, escapeDiscord, excerpt, DISCORD_NO_MENTIONS } from "./chat-markup";

/**
 * BP-426: a task title reaches a project's shared Slack or Discord channel, and anybody who can
 * create a task can write one. These three functions are the whole of what stops a title from
 * becoming markup in somebody else's room.
 */
describe("escapeSlack", () => {
  /**
   * Slack reads `<url|text>` as a link, so a `>` anywhere inside closes it and whatever follows
   * can open a second link the reader has no reason to distrust. The URL half needs it too: a
   * project key is part of it and is not constrained to a format.
   */
  it("closes the three characters Slack treats as markup", () => {
    expect(escapeSlack("a <b> c")).toBe("a &lt;b&gt; c");
  });

  it("cannot be used to close a link and open another", () => {
    const title = "Fix login> <https://evil.example|Click here to reset your password>";

    expect(escapeSlack(title)).not.toContain("<https://evil.example");
    expect(escapeSlack(title)).not.toMatch(/[<>]/);
  });

  /**
   * The ampersand is replaced first. Doing it after would find the ones this function had just
   * written and turn `&lt;` into `&amp;lt;`, so a title with a `<` in it would render the entity
   * rather than the character.
   */
  it("escapes the ampersand before the angle brackets, not after", () => {
    expect(escapeSlack("a & b < c")).toBe("a &amp; b &lt; c");
    expect(escapeSlack("<")).toBe("&lt;");
  });

  it("leaves text with none of the three exactly as it was", () => {
    expect(escapeSlack("Ordinary title, 100% fine — really")).toBe(
      "Ordinary title, 100% fine — really"
    );
  });

  it("escapes every occurrence, not only the first", () => {
    expect(escapeSlack("<<<")).toBe("&lt;&lt;&lt;");
  });

  it("does nothing to an empty string", () => {
    expect(escapeSlack("")).toBe("");
  });
});

describe("escapeDiscord", () => {
  it("backslashes every markup character Discord acts on", () => {
    expect(escapeDiscord("*bold* _italic_ ~strike~ `code`")).toBe(
      "\\*bold\\* \\_italic\\_ \\~strike\\~ \\`code\\`",
    );
  });

  it("escapes a heading, a quote, a link and a spoiler", () => {
    expect(escapeDiscord("# Heading")).toBe("\\# Heading");
    expect(escapeDiscord("> quoted")).toBe("\\> quoted");
    expect(escapeDiscord("[text](https://evil.example)")).toBe(
      "\\[text\\]\\(https://evil.example\\)",
    );
    expect(escapeDiscord("||spoiler||")).toBe("\\|\\|spoiler\\|\\|");
  });

  /**
   * The backslash itself is in the set, which is what stops a title ending in one from escaping
   * the character this function adds after it and cancelling its own escape.
   */
  it("escapes the backslash, so a trailing one cannot eat the next escape", () => {
    expect(escapeDiscord("ends with a backslash\\")).toBe("ends with a backslash\\\\");
    expect(escapeDiscord("\\*not bold*")).toBe("\\\\\\*not bold\\*");
  });

  /**
   * `@everyone` is deliberately NOT escaped here. Discord has no escape for a mention in
   * `content` — the refusal is made at the API instead, with `allowed_mentions`, which is what
   * DISCORD_NO_MENTIONS is for. Escaping the `@` would only put a backslash on screen.
   */
  it("leaves a mention alone, because allowed_mentions is what refuses it", () => {
    expect(escapeDiscord("ping @everyone")).toBe("ping @everyone");
    expect(DISCORD_NO_MENTIONS).toEqual({ parse: [] });
  });

  it("leaves ordinary text alone", () => {
    expect(escapeDiscord("Ordinary title — really")).toBe("Ordinary title — really");
  });
});

describe("excerpt", () => {
  it("leaves text within the limit alone", () => {
    expect(excerpt("short", 10)).toBe("short");
    expect(excerpt("exactly10!", 10)).toBe("exactly10!");
  });

  it("cuts to the limit and marks the cut", () => {
    expect(excerpt("0123456789abc", 10)).toBe("0123456789...");
  });

  /**
   * Cutting before escaping is the order that matters, and it is the caller's to keep: a cut made
   * afterwards can land inside an entity `escapeSlack` wrote, or after a lone backslash
   * `escapeDiscord` wrote — either of which is markup the escape was meant to have neutralised.
   */
  it("is safe to escape after cutting, and unsafe the other way round", () => {
    const title = `${"x".repeat(9)}&more`;

    expect(escapeSlack(excerpt(title, 10))).toBe("xxxxxxxxx&amp;...");
    // The other order cuts the entity in half and leaves a bare ampersand behind.
    expect(excerpt(escapeSlack(title), 10)).toBe("xxxxxxxxx&...");
  });

  it("copes with a limit of zero", () => {
    expect(excerpt("anything", 0)).toBe("...");
  });
});
