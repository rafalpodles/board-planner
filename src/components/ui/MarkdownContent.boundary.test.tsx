// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Whatever the parser throws from below the guard's limits, the render must not take the page with it
const parser = vi.hoisted(() => ({ throws: true }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    if (parser.throws) throw new RangeError("Maximum call stack size exceeded");
    return <p data-testid="parsed">{children}</p>;
  },
}));

import { MarkdownContent } from "./MarkdownContent";

beforeEach(() => {
  parser.throws = true;
  // React reports an error a boundary caught
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a body the parser throws on", () => {
  it("is shown as its text, and the rest of the page renders", () => {
    const { container } = render(
      <div>
        <h1>The task</h1>
        <MarkdownContent>{"some **nested** body"}</MarkdownContent>
        <footer>after it</footer>
      </div>
    );

    expect(container.querySelector("h1")?.textContent).toBe("The task");
    expect(container.querySelector("[data-markdown=raw]")?.textContent).toBe("some **nested** body");
    expect(container.querySelector("footer")?.textContent).toBe("after it");
  });

  it("is a span in a row of other things, and a block with a note elsewhere", () => {
    const inline = render(<MarkdownContent inline>{"a body"}</MarkdownContent>);
    expect(inline.container.querySelector("span[data-markdown=raw]")).not.toBeNull();
    expect(inline.container.querySelector("[data-markdown=note]")).toBeNull();
    cleanup();

    const block = render(<MarkdownContent>{"a body"}</MarkdownContent>);
    expect(block.container.querySelector("div[data-markdown=raw]")).not.toBeNull();
    expect(block.container.querySelector("[data-markdown=note]")).not.toBeNull();
  });

  it("is parsed again when the body changes", () => {
    const { container, rerender } = render(<MarkdownContent>{"first"}</MarkdownContent>);
    expect(container.querySelector("[data-markdown=raw]")).not.toBeNull();

    parser.throws = false;
    rerender(<MarkdownContent>{"second"}</MarkdownContent>);

    expect(container.querySelector("[data-markdown=raw]")).toBeNull();
    expect(container.querySelector("[data-testid=parsed]")?.textContent).toBe("second");
  });

  it("keeps showing the text while the same body is rendered again", () => {
    const { container, rerender } = render(<MarkdownContent>{"same"}</MarkdownContent>);
    parser.throws = false;

    rerender(<MarkdownContent>{"same"}</MarkdownContent>);

    expect(container.querySelector("[data-markdown=raw]")?.textContent).toBe("same");
  });
});
