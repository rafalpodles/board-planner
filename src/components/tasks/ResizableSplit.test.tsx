// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ResizableSplit, clampAside, DEFAULT_ASIDE, MIN_ASIDE, MIN_MAIN } from "./ResizableSplit";

// Mocked per module rather than by patching window.matchMedia: test files run in
// parallel over one global, and a sibling file's patch would land mid-test
const { viewport } = vi.hoisted(() => ({ viewport: { wide: false } }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => viewport.wide }));

function setViewport(wide: boolean) {
  viewport.wide = wide;
}

function renderSplit() {
  return render(
    <ResizableSplit asideLabel="activity" aside={<div data-testid="aside">activity</div>}>
      <div data-testid="main">content</div>
    </ResizableSplit>
  );
}

function grid(container: HTMLElement) {
  return container.querySelector<HTMLElement>(".grid");
}

// happy-dom lays nothing out, so every element measures 0 wide; the split needs
// a real container width to clamp against
function setContainerWidth(width: number) {
  Element.prototype.getBoundingClientRect = function () {
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} };
  };
}

beforeEach(() => {
  localStorage.clear();
  setViewport(true);
  setContainerWidth(1200);
});
afterEach(cleanup);

describe("clampAside", () => {
  it("refuses to shrink the aside past its minimum", () => {
    expect(clampAside(10, 1200)).toBe(MIN_ASIDE);
  });

  it("refuses to starve the main column", () => {
    const container = 1000;
    const widest = clampAside(9999, container);
    expect(container - widest).toBeGreaterThanOrEqual(MIN_MAIN);
  });

  // Both minimums cannot be honoured in a narrow container; the aside keeps its
  // own rather than the clamp inverting and returning something below it
  it("still returns the minimum when the container cannot fit both", () => {
    expect(clampAside(400, 300)).toBe(MIN_ASIDE);
  });

  it("leaves a width that already fits alone", () => {
    expect(clampAside(420, 1400)).toBe(420);
  });
});

describe("ResizableSplit", () => {
  it("splits into content, divider and aside when there is room", () => {
    const { container } = renderSplit();
    expect(grid(container)!.style.gridTemplateColumns).toBe(
      `minmax(0,1fr) 9px ${DEFAULT_ASIDE}px`
    );
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("stacks with no divider on a narrow screen", () => {
    setViewport(false);
    const { container } = renderSplit();
    expect(grid(container)).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("aside")).toBeTruthy();
  });

  it("restores the width it was left at", () => {
    localStorage.setItem("task-detail-aside-width", "480");
    const { container } = renderSplit();
    expect(grid(container)!.style.gridTemplateColumns).toContain("480px");
  });

  it("ignores a stored width that is not a usable number", () => {
    localStorage.setItem("task-detail-aside-width", "not-a-width");
    const { container } = renderSplit();
    expect(grid(container)!.style.gridTemplateColumns).toContain(`${DEFAULT_ASIDE}px`);
  });

  it("widens and narrows the aside from the keyboard, and remembers it", () => {
    const { container } = renderSplit();
    const separator = screen.getByRole("separator");

    act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(grid(container)!.style.gridTemplateColumns).toContain("384px");
    expect(localStorage.getItem("task-detail-aside-width")).toBe("384");

    act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(grid(container)!.style.gridTemplateColumns).toContain("360px");
  });

  // Resizing before the browser has laid the container out would clamp to the
  // minimum and write that over whatever the user had chosen
  it("does not overwrite the stored width from an unmeasured container", () => {
    localStorage.setItem("task-detail-aside-width", "480");
    setContainerWidth(0);
    const { container } = renderSplit();

    act(() => {
      screen
        .getByRole("separator")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(localStorage.getItem("task-detail-aside-width")).toBe("480");
    expect(grid(container)!.style.gridTemplateColumns).toContain("480px");
  });

  // A held arrow key repeats faster than React re-renders; each repeat must build
  // on the last, not restart from the width that was last painted
  it("accumulates rapid nudges instead of restarting from the rendered width", () => {
    const { container } = renderSplit();
    const separator = screen.getByRole("separator");

    act(() => {
      for (let i = 0; i < 3; i++) {
        separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      }
    });

    expect(grid(container)!.style.gridTemplateColumns).toContain(`${DEFAULT_ASIDE + 72}px`);
    expect(localStorage.getItem("task-detail-aside-width")).toBe(String(DEFAULT_ASIDE + 72));
  });

  it("stops at the minimums however long the key is held", () => {
    const { container } = renderSplit();
    const separator = screen.getByRole("separator");
    const hold = (key: string) =>
      act(() => {
        for (let i = 0; i < 60; i++) {
          separator.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        }
      });

    hold("ArrowRight");
    expect(grid(container)!.style.gridTemplateColumns).toContain(`${MIN_ASIDE}px`);

    hold("ArrowLeft");
    const widest = 1200 - MIN_MAIN - 9;
    expect(grid(container)!.style.gridTemplateColumns).toContain(`${widest}px`);
  });

  it("hides the aside behind a toggle and offers it back", () => {
    const { container } = renderSplit();

    act(() => screen.getByRole("button", { name: "Hide activity" }).click());
    expect(screen.queryByTestId("aside")).toBeNull();
    expect(localStorage.getItem("task-detail-aside-collapsed")).toBe("1");

    act(() => screen.getByRole("button", { name: "Show activity" }).click());
    expect(screen.getByTestId("aside")).toBeTruthy();
    expect(localStorage.getItem("task-detail-aside-collapsed")).toBe("0");
  });

  // Collapsing must not move the control out from under the cursor: the toggle
  // keeps its own column at the right instead of dropping below the content
  it("leaves the toggle where it was when the aside collapses", () => {
    const { container } = renderSplit();

    act(() => screen.getByRole("button", { name: "Hide activity" }).click());

    const cells = grid(container)!.children;
    expect(grid(container)!.style.gridTemplateColumns).toBe("minmax(0,1fr) auto");
    expect(cells[cells.length - 1].contains(screen.getByRole("button", { name: "Show activity" })))
      .toBe(true);
  });

  it("keeps the toggle under the content when stacked", () => {
    setViewport(false);
    localStorage.setItem("task-detail-aside-collapsed", "1");
    const { container } = renderSplit();

    expect(grid(container)).toBeNull();
    expect(screen.getByRole("button", { name: "Show activity" })).toBeTruthy();
  });

  it("comes back collapsed if that is how it was left", () => {
    localStorage.setItem("task-detail-aside-collapsed", "1");
    renderSplit();
    expect(screen.queryByTestId("aside")).toBeNull();
    expect(screen.getByRole("button", { name: "Show activity" })).toBeTruthy();
  });

  // The main column keeps its own scroll; a collapsed aside must not take the
  // content with it
  it("keeps the content visible in every state", () => {
    const { rerender } = renderSplit();
    expect(screen.getByTestId("main")).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Hide activity" }).click());
    expect(screen.getByTestId("main")).toBeTruthy();

    setViewport(false);
    rerender(
      <ResizableSplit asideLabel="activity" aside={<div data-testid="aside" />}>
        <div data-testid="main">content</div>
      </ResizableSplit>
    );
    expect(screen.getByTestId("main")).toBeTruthy();
  });
});
