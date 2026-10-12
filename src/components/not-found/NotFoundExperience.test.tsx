// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NotFoundExperience } from "./NotFoundExperience";
import { BoardLoadFailed } from "@/components/ui/LoadFailed";

afterEach(cleanup);

describe("Lost card missing-page experience (BP-262)", () => {
  it("gives the same safe recovery for a missing and an inaccessible board", () => {
    const { rerender } = render(<BoardLoadFailed reason={{ status: 404 }} onRetry={vi.fn()} />);
    const missing = screen.getByRole("alert").textContent;
    expect(screen.getByRole("link", { name: "Back to projects" }).getAttribute("href")).toBe("/projects");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    rerender(<BoardLoadFailed reason={{ status: 403 }} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe(missing);
    expect(screen.getByRole("heading", { name: "This one slipped off the board." })).toBeTruthy();
    expect(document.title).toBe("Page not found — Board Planner");
  });

  it("lets someone recover an unknown organisation through the platform sign-in", () => {
    render(<NotFoundExperience kind="organisation" standalone signIn="https://login.board-planner.com" />);
    expect(screen.getByRole("heading", { name: "Right tool. Wrong address." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Find my organisation" }).getAttribute("href")).toBe("https://login.board-planner.com/?switch");
    expect(screen.queryByRole("link", { name: "Back to projects" })).toBeNull();
  });

  it("labels a suspension as a pause and offers no impossible access action", () => {
    render(<NotFoundExperience kind="suspended" standalone />);
    expect(screen.getByRole("status").textContent).toContain("ORGANISATION / ON PAUSE");
    expect(screen.getByRole("status").textContent).not.toContain("404");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
