// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { usePanelClamp } from "./use-panel-clamp";

/**
 * What the end-to-end spec provably cannot reach. Below `sm` both panels are anchored `right-0`, so
 * their raw right edge is the button's and can never exceed the viewport; above it, Filters at
 * `left-0` is 340 wide against 640+. The right-hand arm of the clamp is therefore unreachable
 * through the product — it is the arm BP-491's abandoned `left-0` fix needed, and it stays because
 * the next panel to use this hook may be anchored the other way.
 */
let rect = { left: 0, right: 0, width: 0 };

function Panel({ open }: { open: boolean }) {
  const panel = usePanelClamp(open);
  return open ? <div data-testid="panel" ref={panel.ref} style={panel.style} /> : null;
}

beforeEach(() => {
  // Each case renders its own panel; without this they accumulate in one document
  cleanup();
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true, writable: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  // Reported in viewport coordinates, the way a browser does: the transform this hook applies is
  // part of what the next read sees, which is exactly the compounding the hook has to undo.
  Element.prototype.getBoundingClientRect = function () {
    const shift = parseFloat(/translateX\((-?[\d.]+)px\)/.exec((this as HTMLElement).style.transform ?? "")?.[1] ?? "0");
    return { left: rect.left + shift, right: rect.right + shift, width: rect.width } as DOMRect;
  };
});

const shiftOf = () => screen.getByTestId("panel").style.transform;

describe("usePanelClamp", () => {
  it("pulls a panel back from the left edge", () => {
    rect = { left: -242, right: 98, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("pulls a panel back from the right edge", () => {
    rect = { left: 300, right: 640, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(-252px)");
  });

  // The control: a panel that is already where it should be must not be moved at all, or a desktop
  // popover is torn off its button by a clamp that thinks it is helping.
  it("leaves a panel that already fits exactly where it is", () => {
    rect = { left: 40, right: 380, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });

  it("prefers the left edge when the panel is wider than the screen", () => {
    rect = { left: -50, right: 450, width: 500 };
    render(<Panel open />);
    // Left satisfied (12), right deliberately not: what runs off the right can be scrolled to.
    expect(shiftOf()).toBe("translateX(62px)");
  });

  /**
   * The trap in re-measuring: the second read sees the transform the first one applied, so a clamp
   * that does not subtract what it already moved compounds — here it would answer 254 and then 508.
   */
  it("re-measures from the un-shifted position rather than compounding", () => {
    rect = { left: -242, right: 98, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("follows an anchor that moves while the panel is open", () => {
    rect = { left: -242, right: 98, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    // The count badge appears and the button's right edge goes 98 -> 120
    rect = { left: -220, right: 120, width: 340 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(232px)");
  });

  it("does not shift a panel it cannot measure", () => {
    rect = { left: 0, right: 0, width: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });
});
