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
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*(\d+)px/.test(query)
      ? width >= Number(/min-width:\s*(\d+)px/.exec(query)![1])
      : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
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

  it("re-measures when the thing in the corner moves", () => {
    stateViewport(800);
    const bar = obstacle({ top: 720, bottom: 776 });
    mounted();
    act(() => raise("Saved"));
    expect(tray().style.bottom).toBe("96px");

    // The comment bar arrives over 200ms of `max-height`, so the floor measured on the raise is
    // not the one the reader ends up with
    stateRect(bar, { top: 600, bottom: 800 });
    act(() => {
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

    // The MutationObserver delivers on a microtask, so the assertion has to wait for one
    await act(async () => {
      panel({ top: 32, bottom: 704 }, 69);
    });

    expect(tray().style.top).toBe("85px");
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
