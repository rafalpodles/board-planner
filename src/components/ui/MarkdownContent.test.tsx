// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

const PEOPLE = [
  { username: "member", fullName: "Mia Member" },
  { username: "jan.kowalski", fullName: "Jan Kowalski" },
];

const pills = (container: HTMLElement) =>
  [...container.querySelectorAll("span.mention")].map((el) => ({
    text: el.textContent,
    title: el.getAttribute("title"),
  }));

describe("a mention", () => {
  it("renders a person of this board as a pill naming them on hover", () => {
    const { container } = render(<MarkdownContent mentions={PEOPLE}>{"@member could you look?"}</MarkdownContent>);

    expect(pills(container)).toEqual([{ text: "@member", title: "Mia Member" }]);
    expect(container.textContent).toBe("@member could you look?");
  });

  it("keeps a dotted username whole and leaves the full stop that ends the sentence", () => {
    const { container } = render(
      <MarkdownContent mentions={PEOPLE}>{"thanks @jan.kowalski. And @member."}</MarkdownContent>
    );

    expect(pills(container).map((p) => p.text)).toEqual(["@jan.kowalski", "@member"]);
    expect(container.textContent).toBe("thanks @jan.kowalski. And @member.");
  });

  it("matches the username whatever case it was written in", () => {
    const { container } = render(<MarkdownContent mentions={PEOPLE}>{"@Member"}</MarkdownContent>);

    expect(pills(container)).toEqual([{ text: "@Member", title: "Mia Member" }]);
  });

  it("leaves someone the board cannot mention as the text that was written", () => {
    const { container } = render(<MarkdownContent mentions={PEOPLE}>{"@stranger hello"}</MarkdownContent>);

    expect(pills(container)).toEqual([]);
    expect(container.querySelector("strong, code")).toBeNull();
    expect(container.textContent).toBe("@stranger hello");
  });

  it("is not found in an e-mail address, a code span, a fenced block or a link", () => {
    const { container } = render(
      <MarkdownContent mentions={PEOPLE}>
        {"write to me@member or ops@member.example, run `@member`, see [@member](https://example.com)\n\n```\n@member\n```"}
      </MarkdownContent>
    );

    expect(pills(container)).toEqual([]);
    expect(container.querySelector("code")?.textContent).toBe("@member");
    expect(container.querySelector("a[href=\"https://example.com\"]")?.textContent).toBe("@member");
  });

  it("stays plain text where mentions are off", () => {
    const { container } = render(<MarkdownContent>{"@member could you look?"}</MarkdownContent>);

    expect(pills(container)).toEqual([]);
    expect(container.textContent).toBe("@member could you look?");
  });

  it("keeps the markdown around it", () => {
    const { container } = render(
      <MarkdownContent mentions={PEOPLE}>{"**done**, @member\n\n- one\n- two"}</MarkdownContent>
    );

    expect(container.querySelector("strong")?.textContent).toBe("done");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(pills(container).map((p) => p.text)).toEqual(["@member"]);
  });
});

describe("code", () => {
  it("marks inline code for the stylesheet's badge, not as a block", () => {
    const { container } = render(<MarkdownContent>{"run `npm test` now"}</MarkdownContent>);

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("npm test");
    expect(code?.classList.contains("md-code")).toBe(true);
    expect(code?.parentElement?.tagName).toBe("P");
  });

  it("keeps a fenced block inside its pre, where the badge selector does not reach", () => {
    const { container } = render(<MarkdownContent>{"```ts\nconst a = 1;\n```"}</MarkdownContent>);

    const code = container.querySelector("pre > code");
    expect(code?.classList.contains("md-code")).toBe(true);
    expect(code?.classList.contains("language-ts")).toBe(true);
  });

  it("gives inline code in a one-line surface the same mark", () => {
    const { container } = render(<MarkdownContent inline>{"returns `null`"}</MarkdownContent>);

    expect(container.querySelector("code.md-code")?.textContent).toBe("null");
  });
});

// BP-1107. react-markdown parses while it renders: a body nested deeper than the parser can follow
// stalled the tab for seconds and then threw out of the tree it sat in, so a comment of 6,000 `>`
// took the page down for everyone who opened it
describe("a body too costly to parse", () => {
  it.each([
    ["blockquotes", ">".repeat(15000)],
    ["list items", "- ".repeat(7500)],
    ["emphasis markers", "_*".repeat(10000)],
  ])("is shown as the text it was written as, at once, for %s", (_label, body) => {
    const started = performance.now();
    const { container } = render(<MarkdownContent>{`${body}x`}</MarkdownContent>);

    expect(performance.now() - started).toBeLessThan(500);
    const raw = container.querySelector("[data-markdown=raw]");
    expect(raw?.textContent).toBe(`${body}x`);
    expect(container.querySelector("blockquote, ul, ol, em, strong")).toBeNull();
  });

  it("keeps the text of a mention, a link and a code span as written", () => {
    const body = `${">".repeat(600)} @member see [the log](https://example.com) and \`code\``;
    const { container } = render(<MarkdownContent mentions={PEOPLE}>{body}</MarkdownContent>);

    expect(container.querySelector("[data-markdown=raw]")?.textContent).toBe(body);
    expect(container.querySelector("a, code, span.mention")).toBeNull();
  });

  it("is a span inside a row of other things, and a block with a note everywhere else", () => {
    const body = ">".repeat(600);
    const inline = render(<MarkdownContent inline>{body}</MarkdownContent>);
    expect(inline.container.querySelector("span[data-markdown=raw]")).not.toBeNull();
    expect(inline.container.querySelector("[data-markdown=note]")).toBeNull();
    cleanup();
    const block = render(<MarkdownContent>{body}</MarkdownContent>);
    expect(block.container.querySelector("div[data-markdown=raw]")).not.toBeNull();
    expect(block.container.querySelector("[data-markdown=note]")?.textContent).toMatch(/plain text/);
  });

  it("is what a description longer than a comment may be gets, with its headings left as written", () => {
    const body = `# Heading\n\n${"word ".repeat(4100)}`;
    const { container } = render(<MarkdownContent>{body}</MarkdownContent>);

    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("[data-markdown=raw]")?.textContent).toBe(body);
  });

  it("renders nothing, rather than throwing, for a body that is not text", () => {
    const { container } = render(<MarkdownContent>{undefined as unknown as string}</MarkdownContent>);

    expect(container.textContent).toBe("");
  });

  it("is not what an ordinary comment gets", () => {
    const { container } = render(<MarkdownContent>{"**done**\n\n> quoted\n\n- one\n- two"}</MarkdownContent>);

    expect(container.querySelector("[data-markdown=raw]")).toBeNull();
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });
});
