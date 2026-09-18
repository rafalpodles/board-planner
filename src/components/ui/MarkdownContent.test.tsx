// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

// globals.css takes the typography plugin's backticks off `.prose strong > code`, which reaches a
// mention only while this is the shape a mention renders in
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
