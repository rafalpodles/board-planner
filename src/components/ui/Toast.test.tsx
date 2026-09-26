// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { registerLayer } from "@/lib/focus-trap";
import { Modal } from "@/components/ui/Modal";

/**
 * BP-597. Where the tray stands is measured now, so what this file pins is the *wiring*: that the
 * component reads the rectangles the page declares and applies the answer. The arithmetic itself
 * is `toast-placement.test.ts`, which needs no DOM.
 *
 * happy-dom lays nothing out, so every rectangle here is stated — the same shape the Combobox
 * placement tests use.
 */

let raise: (message: string) => void;

// `openLayers` is module state, so a layer left open leaks into the next test's first render
const opened: (() => void)[] = [];

function openSheet() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  act(() => {
    opened.push(registerLayer(el, { sheet: true, close: () => {} }));
  });
}

// Width as well as height: below `sm` a dialog is a bottom sheet and the tray leaves the corner,
// above it the dialog is centred and the corner is free. happy-dom reports 0 for both, so a test
// that states only the height passes the sheet cases by accident.
function stateViewport(height: number, width = 1280) {
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
  // The component asks a media query rather than `clientWidth`, so that is what has to answer
  vi.spyOn(window, "matchMedia").mockImplementation(((query: string) => ({
    matches: /min-width:\s*(\d+)px/.test(query)
      ? width >= Number(/min-width:\s*(\d+)px/.exec(query)![1])
      : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia);
}

/**
 * happy-dom lays nothing out, so a real `ResizeObserver` would never fire. This one fires for the
 * elements it was actually told to observe, which is the point: a bar that arrives with no height
 * is only caught if the tray starts observing it *then*.
 */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  seen = new Set<Element>();
  constructor(public cb: () => void) {
    FakeResizeObserver.live.push(this);
  }
  observe(el: Element) {
    this.seen.add(el);
  }
  unobserve(el: Element) {
    this.seen.delete(el);
  }
  disconnect() {
    this.seen.clear();
  }
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

function resized(el: Element) {
  FakeResizeObserver.live.forEach((observer) => observer.seen.has(el) && observer.cb());
}

function stateRect(el: Element, box: { top: number; bottom: number }) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...box,
    left: 0,
    right: 100,
    width: 100,
    height: box.bottom - box.top,
    x: 0,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * The open PM panel, with the header its own controls sit in. Both attributes matter: the query
 * for the panel and the query for its header are a contract with `PmChatWidget`, and renaming
 * either sends the tray back onto the composer.
 */
function panel(box: { top: number; bottom: number }, headerBottom: number) {
  const el = document.createElement("div");
  el.setAttribute("data-corner-panel", "");
  const header = document.createElement("div");
  header.setAttribute("data-corner-panel-header", "");
  el.append(header);
  document.body.append(el);
  stateRect(el, box);
  stateRect(header, { top: box.top, bottom: headerBottom });
  return el;
}

/** Something sharing the corner — the PM launcher, a pinned bar */
function obstacle(box: { top: number; bottom: number }) {
  const el = document.createElement("div");
  el.setAttribute("data-corner-obstacle", "");
  document.body.append(el);
  stateRect(el, box);
  return el;
}

function Raiser() {
  raise = useToast().toast;
  return null;
}

/**
 * Re-measuring is coalesced into one microtask (BP-622), so a test that triggers it and reads the
 * tray in the same tick reads the placement from before it. `flush` awaits the microtask inside
 * `act`, which is what the pre-existing tests already did for the MutationObserver's own delivery.
 */
async function flush() {
  await act(async () => {});
}

/** How many times the placement has read the viewport, which `measure` does once per pass */
function measurements() {
  return vi.mocked(Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight")!.get!)
    .mock.calls.length;
}

function mounted() {
  render(
    <ToastProvider>
      <Raiser />
    </ToastProvider>
  );
}

function tray() {
  return screen.getByTestId("toast-tray") as HTMLElement;
}

function trayClasses() {
  return tray().getAttribute("class")!.split(/\s+/);
}

afterEach(() => {
  cleanup();
  FakeResizeObserver.live.length = 0;
  vi.useRealTimers();
  opened.splice(0).forEach((close) => close());
  document
    .querySelectorAll("[data-corner-obstacle],[data-corner-panel]")
    .forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe("where a toast lands", () => {
  it("takes the bottom corner when nothing is over the page", () => {
    stateViewport(800);
    mounted();

    act(() => raise("Saved"));

    expect(tray().style.bottom).toBe("16px");
    expect(tray().style.top).toBe("");
  });

  // Measured 1280×800 on a task page: the launcher is 720–776 and the tray was 740–784, so
  // `elementFromPoint` at the launcher's centre answered "the toast" (BP-597)
  it("stands above what shares the corner, wherever that is", () => {
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    mounted();

    act(() => raise("Saved"));

    expect(tray().style.bottom).toBe("96px");
  });

  // The phone comment bar is `lg:hidden`: on a wide screen it is in the DOM with a zero-height
  // rect at the top of the page, and measuring it would send the tray to the other end
  it("ignores something that is in the page but not on screen", () => {
    stateViewport(800);
    obstacle({ top: 0, bottom: 0 });
    mounted();

    act(() => raise("Saved"));

    expect(tray().style.bottom).toBe("16px");
  });

  it("re-measures when the thing in the corner moves", async () => {
    stateViewport(800);
    const bar = obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("96px");

    // The comment bar arrives over 200ms of `max-height`, so the floor measured on the raise is
    // not the one the reader ends up with
    stateRect(bar, { top: 600, bottom: 800 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(tray().style.bottom).toBe("216px");
  });

  // The panel is nearly the whole screen, so the tray stands on it rather than above it — below
  // its header, which is where its own ⤢ and ✕ are. Measured 1280×800: without this the tray is
  // at 660–704 and the composer's Send at 647–691.
  it("stands in the panel, under the header, when one is open", () => {
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    panel({ top: 32, bottom: 704 }, 69);
    mounted();

    act(() => raise("Saved"));

    expect(tray().style.top).toBe("85px");
    expect(tray().style.bottom).toBe("auto");
  });

  // The panel opens without a resize, so the arrival is what has to be watched
  it("moves onto a panel that opens while the toast is up", async () => {
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("96px");

    // The MutationObserver delivers on a microtask, so the assertion has to wait for one — and
    // then for the frame the re-measure is coalesced into
    await act(async () => {
      panel({ top: 32, bottom: 704 }, 69);
    });

    expect(tray().style.top).toBe("85px");
  });

  // `SaveBar` is always mounted and turns its attribute on in the same commit that starts a 200ms
  // `max-height`: at the moment it announces itself it is still zero tall and `measure` discards
  // it. Catching the growth means observing it on arrival, not once at setup.
  it("watches a bar that announces itself before it has any height", async () => {
    stateViewport(800);
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("16px");

    const bar = obstacle({ top: 800, bottom: 800 });
    await act(async () => {});
    expect(tray().style.bottom).toBe("16px");

    stateRect(bar, { top: 600, bottom: 800 });
    await act(async () => resized(bar));

    expect(tray().style.bottom).toBe("216px");
  });

  /**
   * BP-622. `childList` with `subtree` fires on every node inserted or removed anywhere in the
   * app, and a toast lives three seconds — long enough for the board's ten-second poll to re-render
   * its cards, or for a dnd-kit drag to rewrite the DOM on every pointer move. Each record ran two
   * whole-document `querySelectorAll` and then forced a layout.
   *
   * Counted rather than eyeballed: `measure` reads the viewport height once per pass, so the spy
   * on it is the measurement count.
   */
  it("ignores a DOM change that cannot move the tray", async () => {
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    const before = measurements();

    // A card re-rendering under the toast: a node arrives, and it is none of the things the
    // placement reads
    await act(async () => {
      const card = document.createElement("div");
      card.textContent = "a task card";
      document.body.appendChild(card);
    });

    await flush();
    expect(measurements()).toBe(before);
  });

  it("still moves for the panel, which arrives the same way", async () => {
    // The control for the test above: the narrowing must not cost BP-597 its own case
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));

    await act(async () => {
      panel({ top: 32, bottom: 704 }, 69);
    });

    expect(tray().style.top).toBe("85px");
  });

  it("costs one layout for a burst, not one each", async () => {
    stateViewport(800);
    const bar = obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    const before = measurements();

    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      resized(bar);
      document.dispatchEvent(new Event("scroll"));
    });

    // Four askers, one measurement
    await flush();
    expect(measurements()).toBe(before + 1);
  });

  /**
   * BP-625. A `sticky bottom-0` bar whose column ends before its scrollport does moves when the
   * scroll reaches the point where it un-sticks. That is no resize and no mutation — the bar's size
   * and the DOM are both untouched — so nothing else here notices, and the offset computed when
   * the toast was raised is wrong from then on.
   */
  it("re-places when a sticky bar moves without resizing or changing the DOM", async () => {
    stateViewport(800);
    const bar = obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("96px");

    // The bar un-sticks and rises. No ResizeObserver callback, no mutation: only a scroll.
    stateRect(bar, { top: 600, bottom: 656 });
    await act(async () => {
      document.dispatchEvent(new Event("scroll"));
    });

    expect(tray().style.bottom).toBe("216px");
  });

  /**
   * The listener has to come off with the last toast, and the only honest way to say so is the
   * handler's own identity. Asserting that nothing measures afterwards passes whether or not the
   * listener was removed: the effect's cleanup also sets a flag that suppresses a queued
   * re-measure, so a leaked listener is absorbed downstream and the test reads the flag rather
   * than the teardown it names.
   */
  it("takes its scroll listener off with the last toast", async () => {
    vi.useFakeTimers();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    stateViewport(800);
    obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));

    const listener = added.mock.calls.find(([type]) => type === "scroll")?.[1];
    expect(listener, "a scroll listener was added while a toast was up").toBeTypeOf("function");

    // The toast's own three seconds. The tray unmounts and the effect bails out.
    act(() => vi.advanceTimersByTime(3100));
    expect(screen.queryByTestId("toast-tray")).toBeNull();

    expect(
      removed.mock.calls.some(([type, fn]) => type === "scroll" && fn === listener),
      "the same handler was removed"
    ).toBe(true);
  });

  it("goes to the top over a sheet, whatever else is in the corner", () => {
    stateViewport(800, 390);
    obstacle({ top: 720, bottom: 776 });
    mounted();
    openSheet();

    act(() => raise("Saved"));

    expect(tray().style.top).toBe("16px");
  });

  it("moves a toast that was already up when the sheet opened", () => {
    stateViewport(800, 390);
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("16px");

    openSheet();

    expect(tray().style.top).toBe("16px");
  });

  it("takes the corner back once the last sheet closes", () => {
    stateViewport(800, 390);
    mounted();
    openSheet();
    act(() => raise("Saved"));
    expect(tray().style.top).toBe("16px");

    act(() => opened.splice(0).forEach((close) => close()));

    expect(tray().style.bottom).toBe("16px");
  });

  // A full-screen `bare` dialog is a layer with no action row at the bottom; its controls are the
  // back and overflow buttons at the *top*, which is where sending the toast would land on them
  it("stays in the corner under a real bare Modal", () => {
    stateViewport(800);
    render(
      <ToastProvider>
        <Raiser />
        <Modal open onClose={() => {}} title="TP-3" bare>
          <p>the task</p>
        </Modal>
      </ToastProvider>
    );

    act(() => raise("Saved"));

    expect(tray().style.bottom).toBe("16px");
  });

  it("moves for a real Modal, which is a sheet", () => {
    stateViewport(800, 390);
    render(
      <ToastProvider>
        <Raiser />
        <Modal open onClose={() => {}} title="Delete task">
          <p>are you sure</p>
        </Modal>
      </ToastProvider>
    );

    act(() => raise("Saved"));

    expect(tray().style.top).toBe("16px");
  });

  // The same dialog on a wide screen is centred, not a sheet, so the corner stays the corner
  it("keeps the corner over a dialog on a wide screen", () => {
    stateViewport(800, 1280);
    render(
      <ToastProvider>
        <Raiser />
        <Modal open onClose={() => {}} title="Delete task">
          <p>are you sure</p>
        </Modal>
      </ToastProvider>
    );

    act(() => raise("Saved"));

    expect(tray().style.bottom).toBe("16px");
  });

  it("is painted above the scrim either way", () => {
    stateViewport(800);
    mounted();

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("z-50");
  });
});

// BP-753: a toast that offers the next step, rather than only reporting the last one
describe("a toast with an action", () => {
  function ActionRaiser({ onAction }: { onAction: () => void }) {
    const { toast, dismiss } = useToast();
    dismissById = dismiss;
    raiseWithAction = () =>
      toast("Ada's account is ready.", "success", {
        action: { label: "Add to a board", onClick: onAction },
      });
    return null;
  }
  let raiseWithAction: () => number;
  let dismissById: (id: number) => void;

  function mountWithAction(onAction = vi.fn()) {
    stateViewport(800);
    render(
      <ToastProvider>
        <Raiser />
        <ActionRaiser onAction={onAction} />
      </ToastProvider>
    );
    return onAction;
  }

  it("runs the action and closes the toast", () => {
    const onAction = mountWithAction();
    act(() => raiseWithAction());

    act(() => screen.getByRole("button", { name: "Add to a board" }).click());

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("stays long enough to be acted on, where a plain toast has gone", () => {
    vi.useFakeTimers();
    try {
      mountWithAction();
      act(() => raiseWithAction());
      act(() => raise("Saved"));
      expect(screen.getAllByTestId("toast")).toHaveLength(2);

      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getAllByTestId("toast").map((t) => t.textContent)).toEqual([
        "Ada's account is ready.Add to a board",
      ]);

      act(() => vi.advanceTimersByTime(6999));
      expect(screen.getAllByTestId("toast")).toHaveLength(1);

      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId("toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be taken down by whoever raised it", () => {
    mountWithAction();
    let id = 0;
    act(() => {
      id = raiseWithAction();
    });
    act(() => raise("Saved"));

    act(() => dismissById(id));

    expect(screen.getAllByTestId("toast").map((t) => t.textContent)).toEqual(["Saved"]);
  });
});
