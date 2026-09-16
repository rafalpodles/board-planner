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
let rect = { left: 0, right: 0, width: 0, top: 0, height: 0 };
let scrollerBottom = 800;

function Panel({ open }: { open: boolean }) {
  const panel = usePanelClamp(open);
  return open ? <div data-testid="panel" ref={panel.ref} style={panel.style} /> : null;
}

beforeEach(() => {
  // Each case renders its own panel; without this they accumulate in one document
  cleanup();
  scrollerBottom = 800;
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true });
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
    if ((this as HTMLElement).dataset.testid === "scroller") {
      const box = { x: 260, y: 0, left: 260, right: 400, top: 0, bottom: scrollerBottom, width: 140, height: scrollerBottom };
      return { ...box, toJSON: () => box } as DOMRect;
    }
    const shift = parseFloat(/translateX\((-?[\d.]+)px\)/.exec((this as HTMLElement).style.transform ?? "")?.[1] ?? "0");
    const box = {
      x: rect.left + shift,
      y: rect.top,
      left: rect.left + shift,
      right: rect.right + shift,
      top: rect.top,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    };
    return { ...box, toJSON: () => box } as DOMRect;
  };
});

const shiftOf = () => screen.getByTestId("panel").style.transform;
const maxHeightOf = () => screen.getByTestId("panel").style.maxHeight;

describe("usePanelClamp", () => {
  it("pulls a panel back from the left edge", () => {
    rect = { left: -242, right: 98, width: 340, top: 0, height: 277 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("pulls a panel back from the right edge", () => {
    rect = { left: 300, right: 640, width: 340, top: 0, height: 277 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(-252px)");
  });

  // The control: a panel that is already where it should be must not be moved at all, or a desktop
  // popover is torn off its button by a clamp that thinks it is helping.
  it("leaves a panel that already fits exactly where it is", () => {
    rect = { left: 40, right: 380, width: 340, top: 0, height: 277 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });

  it("prefers the left edge when the panel is wider than the screen", () => {
    rect = { left: -50, right: 450, width: 500, top: 0, height: 277 };
    render(<Panel open />);
    // Left satisfied (12), right deliberately not: what runs off the right can be scrolled to.
    expect(shiftOf()).toBe("translateX(62px)");
  });

  /**
   * The trap in re-measuring: the second read sees the transform the first one applied, so a clamp
   * that does not subtract what it already moved compounds — here it would answer 254 and then 508.
   */
  it("re-measures from the un-shifted position rather than compounding", () => {
    rect = { left: -242, right: 98, width: 340, top: 0, height: 277 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("follows an anchor that moves while the panel is open", () => {
    rect = { left: -242, right: 98, width: 340, top: 0, height: 277 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    // The count badge appears and the button's right edge goes 98 -> 120
    rect = { left: -220, right: 120, width: 340, top: 0, height: 277 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(232px)");
  });

  it("does not shift a panel it cannot measure", () => {
    rect = { left: 0, right: 0, width: 0, top: 0, height: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
    expect(maxHeightOf()).toBe("");
  });

  it("bounds the panel to the room below its anchor, and lets it scroll", () => {
    rect = { left: 12, right: 352, width: 340, top: 138, height: 277 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("650px");
    expect(screen.getByTestId("panel").style.overflowY).toBe("auto");
    expect(screen.getByTestId("panel").style.scrollPaddingBlock).toBe("5px");
  });

  it("re-measures when the page scrolls under an open panel", async () => {
    rect = { left: 12, right: 352, width: 340, top: 138, height: 277 };
    render(<Panel open />);
    expect(maxHeightOf()).toBe("650px");

    rect = { left: 12, right: 352, width: 340, top: 500, height: 277 };
    await act(async () => {
      // Non-bubbling: only a capturing listener sees it
      document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(maxHeightOf()).toBe("288px");
  });

  it("measures once for a burst of scroll events, not once each", async () => {
    rect = { left: 12, right: 352, width: 340, top: 138, height: 277 };
    render(<Panel open />);
    const measured = vi.spyOn(Element.prototype, "getBoundingClientRect");

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(measured).toHaveBeenCalledTimes(1);
    measured.mockRestore();
  });

  it("measures the room from the anchor, not from a fraction of the viewport", () => {
    rect = { left: 12, right: 352, width: 340, top: 600, height: 277 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("188px");
  });

  it("never offers more height than the screen has", () => {
    rect = { left: 12, right: 352, width: 340, top: -200, height: 277 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("788px");
  });

  it("never offers a negative height to a panel below the fold", () => {
    rect = { left: -242, right: 98, width: 340, top: 900, height: 277 };
    render(<Panel open />);

    // Positive control: an empty maxHeight alone cannot tell a floored bound from no measure
    expect(shiftOf()).toBe("translateX(254px)");
    expect(maxHeightOf()).toBe("");
  });

  // BP-637: <main> scrolls, so beside the sidebar a panel on screen was still clipped at main's edge
  it("pulls a panel inside the scroller that clips it, not only inside the screen", () => {
    rect = { left: 188, right: 412, width: 224, top: 0, height: 277 };
    render(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <Panel open />
      </div>
    );

    expect(shiftOf()).toBe("translateX(84px)");
  });

  // From lg up the board wrapper clips 24px above the screen's bottom, below main's padding
  it("bounds the height by the clipper's bottom, not the screen's", () => {
    scrollerBottom = 776;
    rect = { left: 272, right: 400, width: 128, top: 138, height: 277 };
    render(
      <div data-testid="scroller" style={{ overflowY: "hidden" }}>
        <Panel open />
      </div>
    );

    expect(maxHeightOf()).toBe("626px");
  });

  // BP-636: every scrollbar in the app is hidden, so nothing else says a bounded panel continues
  describe("the fade that says there is more", () => {
    let scroll = { height: 0, top: 0, client: 0 };
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll.height });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => scroll.client });
      Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get: () => scroll.top });
    });

    // happy-dom reports a never-set maskImage as undefined and a cleared one as ""
    const maskOf = () => screen.getByTestId("panel").style.maskImage ?? "";

    it("fades the bottom edge while there is content below it", () => {
      scroll = { height: 717, top: 0, client: 171 };
      rect = { left: 12, right: 352, width: 340, top: 600, height: 171 };
      render(<Panel open />);

      expect(maskOf()).toContain("transparent");
    });

    it("drops the fade once the reader has scrolled to the end", async () => {
      scroll = { height: 717, top: 0, client: 171 };
      rect = { left: 12, right: 352, width: 340, top: 600, height: 171 };
      render(<Panel open />);
      expect(maskOf()).toContain("transparent");

      scroll = { height: 717, top: 546, client: 171 };
      await act(async () => {
        screen.getByTestId("panel").dispatchEvent(new Event("scroll", { bubbles: false }));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });

      expect(maskOf()).toBe("");
    });

    // A chip removed unwraps a row: nothing the listeners watch changes, but the overflow does
    it("re-reads the fade when the panel's own content changes", () => {
      scroll = { height: 717, top: 0, client: 171 };
      rect = { left: 12, right: 352, width: 340, top: 600, height: 171 };
      const { rerender } = render(<Panel open />);
      expect(maskOf()).toContain("transparent");

      scroll = { height: 171, top: 0, client: 171 };
      rerender(<Panel open />);

      expect(maskOf()).toBe("");
    });

    it("never fades a panel that fits", () => {
      scroll = { height: 277, top: 0, client: 277 };
      rect = { left: 12, right: 352, width: 340, top: 138, height: 277 };
      render(<Panel open />);

      expect(maxHeightOf()).toBe("650px");
      expect(maskOf()).toBe("");
    });
  });
});
