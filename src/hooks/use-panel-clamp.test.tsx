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
let rect = { left: 0, right: 0, width: 0, top: 0 };

function Panel({ open }: { open: boolean }) {
  const panel = usePanelClamp(open);
  return open ? <div data-testid="panel" ref={panel.ref} style={panel.style} /> : null;
}

beforeEach(() => {
  // Each case renders its own panel; without this they accumulate in one document
  cleanup();
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
  //
  // Every field is present, because the cast is the dangerous part. While `top` was missing the
  // hook read `undefined`, every height arithmetic became NaN, the bound silently produced no
  // style at all, and seven tests stayed green over an implementation that did nothing. A field
  // this literal omits is a field the next reader gets `undefined` for, and NaN never reddens.
  Element.prototype.getBoundingClientRect = function () {
    const shift = parseFloat(/translateX\((-?[\d.]+)px\)/.exec((this as HTMLElement).style.transform ?? "")?.[1] ?? "0");
    const box = {
      x: rect.left + shift,
      y: rect.top,
      left: rect.left + shift,
      right: rect.right + shift,
      top: rect.top,
      bottom: rect.top,
      width: rect.width,
      height: 0,
    };
    return { ...box, toJSON: () => box } as DOMRect;
  };
});

const shiftOf = () => screen.getByTestId("panel").style.transform;
const maxHeightOf = () => screen.getByTestId("panel").style.maxHeight;

describe("usePanelClamp", () => {
  it("pulls a panel back from the left edge", () => {
    rect = { left: -242, right: 98, width: 340, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("pulls a panel back from the right edge", () => {
    rect = { left: 300, right: 640, width: 340, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(-252px)");
  });

  // The control: a panel that is already where it should be must not be moved at all, or a desktop
  // popover is torn off its button by a clamp that thinks it is helping.
  it("leaves a panel that already fits exactly where it is", () => {
    rect = { left: 40, right: 380, width: 340, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });

  it("prefers the left edge when the panel is wider than the screen", () => {
    rect = { left: -50, right: 450, width: 500, top: 0 };
    render(<Panel open />);
    // Left satisfied (12), right deliberately not: what runs off the right can be scrolled to.
    expect(shiftOf()).toBe("translateX(62px)");
  });

  /**
   * The trap in re-measuring: the second read sees the transform the first one applied, so a clamp
   * that does not subtract what it already moved compounds — here it would answer 254 and then 508.
   */
  it("re-measures from the un-shifted position rather than compounding", () => {
    rect = { left: -242, right: 98, width: 340, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(254px)");
  });

  it("follows an anchor that moves while the panel is open", () => {
    rect = { left: -242, right: 98, width: 340, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(254px)");

    // The count badge appears and the button's right edge goes 98 -> 120
    rect = { left: -220, right: 120, width: 340, top: 0 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(shiftOf()).toBe("translateX(232px)");
  });

  it("does not shift a panel it cannot measure", () => {
    rect = { left: 0, right: 0, width: 0, top: 0 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });

  /**
   * `top-full` cannot know how much room is below the anchor. Five controls tipped the Filters
   * panel 40px past the fold at 812x375 with nothing to scroll, so the last one was unreachable.
   */
  it("bounds the panel to the room below its anchor, and lets it scroll", () => {
    rect = { left: 12, right: 352, width: 340, top: 138 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("650px");
    expect(screen.getByTestId("panel").style.overflowY).toBe("auto");
    // The app hides every scrollbar, so the focus ring is the only thing that reaches a
    // control scrolled to the boundary
    expect(screen.getByTestId("panel").style.scrollPaddingBlock).toBe("5px");
  });

  // The toolbar is in normal flow below lg, so the room below it changes as the board scrolls
  it("re-measures when the page scrolls under an open panel", async () => {
    rect = { left: 12, right: 352, width: 340, top: 138 };
    render(<Panel open />);
    expect(maxHeightOf()).toBe("650px");

    rect = { left: 12, right: 352, width: 340, top: 500 };
    // Non-bubbling on purpose: a scroll does not bubble from the element that owns it, so a
    // listener that is not capturing never sees this at all
    await act(async () => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
      // A board scroll moves the anchor every frame; the measure is throttled to one per frame
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(maxHeightOf()).toBe("288px");
  });

  it("measures once for a burst of scroll events, not once each", async () => {
    rect = { left: 12, right: 352, width: 340, top: 138 };
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
    rect = { left: 12, right: 352, width: 340, top: 600 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("188px");
  });

  // A toolbar scrolled above the top of its scroller reports a negative top, and the room below
  // it then computes as taller than the screen — a bound that no longer bounds anything
  it("never offers more height than the screen has", () => {
    rect = { left: 12, right: 352, width: 340, top: -200 };
    render(<Panel open />);

    expect(maxHeightOf()).toBe("788px");
  });

  /**
   * The horizontal shift is the positive control, and it is what makes the assertion mean
   * anything: an empty maxHeight is otherwise indistinguishable from a hook that measured
   * nothing at all. An early return for a below-the-fold anchor would pass without it, while
   * silently disabling the left-edge clamp for every panel on a phone in landscape.
   */
  it("never offers a negative height to a panel below the fold", () => {
    rect = { left: -242, right: 98, width: 340, top: 900 };
    render(<Panel open />);

    expect(shiftOf()).toBe("translateX(254px)");
    expect(maxHeightOf()).toBe("");
  });
});
