// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { usePanelClamp } from "./use-panel-clamp";

let rect = { left: 0, right: 0, width: 0 };

function Panel({ open }: { open: boolean }) {
  const panel = usePanelClamp(open);
  return open ? <div data-testid="panel" ref={panel.ref} style={panel.style} /> : null;
}

beforeEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true, writable: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
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

  it("leaves a panel that already fits exactly where it is", () => {
    rect = { left: 40, right: 380, width: 340 };
    render(<Panel open />);
    expect(shiftOf()).toBe("");
  });

  it("prefers the left edge when the panel is wider than the screen", () => {
    rect = { left: -50, right: 450, width: 500 };
    render(<Panel open />);
    expect(shiftOf()).toBe("translateX(62px)");
  });

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
