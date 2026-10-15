// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SourceBadge } from "./SourceBadge";

describe("SourceBadge", () => {
  afterEach(cleanup);

  it.each([
    ["web-ui", undefined, "Web", "Through the web app"],
    ["mcp", "Notion", "MCP", "Through MCP: Notion"],
    ["pm-agent", "openai/gpt-6-luna", "PM agent", "By the PM agent (openai/gpt-6-luna)"],
    ["worker", "rpo-mbp", "Worker", "By the worker rpo-mbp"],
    ["api", undefined, "API", "Through the API"],
    ["system", undefined, "System", "By Board Planner itself, with nobody acting"],
  ])("names %s and says more on hover", (source, detail, label, title) => {
    render(<SourceBadge source={source} detail={detail} />);
    const badge = screen.getByRole("img", { name: title });
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute("title")).toBe(title);
  });

  it("reads an entry with no source as legacy", () => {
    render(<SourceBadge />);
    expect(screen.getByTestId("source-badge").getAttribute("data-source")).toBe("legacy");
  });

  it("says an edit came through another door", () => {
    render(<SourceBadge source="mcp" detail="Notion" edited />);
    const badge = screen.getByRole("img", { name: "Last edited through MCP: Notion" });
    expect(badge.textContent).toBe("Edited · MCP");
  });

  it("tells a machine apart from a person by its colour", () => {
    const { rerender } = render(<SourceBadge source="web-ui" />);
    expect(screen.getByTestId("source-badge").className).not.toContain("text-primary");
    rerender(<SourceBadge source="worker" />);
    expect(screen.getByTestId("source-badge").className).toContain("text-primary");
  });
});
