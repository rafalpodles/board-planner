// @vitest-environment happy-dom
import { useCallback } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { useHorizontalOverflow } from "./use-horizontal-overflow";

/**
 * The geometry a scroller reports, which happy-dom answers 0 for. Defined on the node rather than
 * mocked on the hook: the arithmetic — and its one-pixel tolerance — is the thing under test.
 */
let geometry = { scrollWidth: 0, clientWidth: 0, scrollLeft: 0 };
let observed: Element[] = [];

class FakeResizeObserver {
  constructor(private cb: () => void) {
    instances.push(this);
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {
    disconnected += 1;
  }
  fire() {
    this.cb();
  }
}
let instances: FakeResizeObserver[] = [];
let disconnected = 0;

function size(el: HTMLElement) {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true });
  }
}

/**
 * The caller's shape: the scroller appears only once the rows it holds have arrived.
 *
 * The merged ref is memoised, and the geometry applied once per node. A fresh callback each render
 * would make React detach and reattach the ref on every state change — the hook would tear down
 * and rebuild its listeners, and re-applying the fixture would undo whatever the test had just
 * changed, so every assertion after the first would read the starting numbers back.
 */
function Table({ loaded }: { loaded: boolean }) {
  const { ref, moreRight } = useHorizontalOverflow<HTMLDivElement>();
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && !sized.has(node)) {
        sized.add(node);
        size(node);
      }
      ref(node);
    },
    [ref]
  );
  if (!loaded) return null;
  return (
    <div data-testid="scroller" data-more={String(moreRight)} ref={attach}>
      <table />
    </div>
  );
}

let sized = new WeakSet<Element>();

const more = () => screen.getByTestId("scroller").getAttribute("data-more");

beforeEach(() => {
  geometry = { scrollWidth: 0, clientWidth: 0, scrollLeft: 0 };
  observed = [];
  instances = [];
  disconnected = 0;
  sized = new WeakSet();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useHorizontalOverflow", () => {
  it("reports content to the right when the scroller is narrower than its table", () => {
    geometry = { scrollWidth: 1104, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(more()).toBe("true");
  });

  it("reports none when the table fits", () => {
    geometry = { scrollWidth: 800, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(more()).toBe("false");
  });

  it("reports none once the scroller is at its right-hand end", () => {
    geometry = { scrollWidth: 1104, clientWidth: 882, scrollLeft: 222 };
    render(<Table loaded />);
    expect(more()).toBe("false");
  });

  // A sub-pixel remainder is a rounding artefact, not content — a shadow drawn for it never goes
  it("ignores a remainder under a pixel", () => {
    geometry = { scrollWidth: 882.6, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(more()).toBe("false");
  });

  /**
   * The bug this hook was rewritten for. The page returns null until its rows load, so an effect
   * holding a `useRef` ran once against no node and — with nothing in its dependencies to change —
   * never measured again, leaving the shadow off for ever on a table that plainly overflowed.
   */
  it("measures a scroller that only appears after the first render", () => {
    geometry = { scrollWidth: 1104, clientWidth: 882, scrollLeft: 0 };
    const { rerender } = render(<Table loaded={false} />);
    expect(screen.queryByTestId("scroller")).toBeNull();

    rerender(<Table loaded />);
    expect(more()).toBe("true");
  });

  it("re-measures when the scroller is scrolled", () => {
    geometry = { scrollWidth: 1104, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(more()).toBe("true");

    const el = screen.getByTestId("scroller");
    Object.defineProperty(el, "scrollLeft", { value: 222, configurable: true });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(more()).toBe("false");
  });

  // The content grows without the scrollport changing: rows arriving is the ordinary case
  it("re-measures when the observer fires", () => {
    geometry = { scrollWidth: 400, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(more()).toBe("false");

    const el = screen.getByTestId("scroller");
    Object.defineProperty(el, "scrollWidth", { value: 1104, configurable: true });
    act(() => {
      instances.forEach((o) => o.fire());
    });
    expect(more()).toBe("true");
  });

  it("watches both the scrollport and the content, and lets go of both", () => {
    geometry = { scrollWidth: 1104, clientWidth: 882, scrollLeft: 0 };
    render(<Table loaded />);
    expect(observed.map((el) => el.tagName)).toEqual(["DIV", "TABLE"]);

    cleanup();
    expect(disconnected).toBeGreaterThan(0);
  });
});
