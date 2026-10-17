// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

// globals.css badges `:not(pre, strong) > code.md-code` and leaves a mention, bold code, a plain name,
// which holds only while this is the shape a mention renders in
describe("a mention", () => {
  it("renders as bold code, the shape the stylesheet takes the backticks off", () => {
    const { container } = render(<MarkdownContent mentions>{"@member could you look?"}</MarkdownContent>);

    expect(container.querySelector("strong > code")?.textContent).toBe("@member");
  });

  it("stays plain text where mentions are off", () => {
    const { container } = render(<MarkdownContent>{"@member could you look?"}</MarkdownContent>);

    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe("@member could you look?");
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
