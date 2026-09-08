// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { registerLayer } from "@/lib/focus-trap";
import { Modal } from "@/components/ui/Modal";

/**
 * BP-590. A phone's dialog is a bottom sheet, and `bottom-4 right-4` at `max-w-sm` is its action
 * row. Which corner the tray claims *is* the fix, so that is what is asserted.
 *
 * Every assertion is word-wise: the class list always carries `sm:bottom-4`, so `toContain` on the
 * string is true whatever the branch chose — a tautology that let a "never returns to the corner"
 * mutation pass this file.
 */

let raise: (message: string) => void;

// `openLayers` is module state, so a layer left open leaks into the next test's first render
const opened: (() => void)[] = [];

function openSheet() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  act(() => {
    opened.push(registerLayer(el, true));
  });
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

function trayClasses() {
  return screen.getByTestId("toast-tray").getAttribute("class")!.split(/\s+/);
}

afterEach(() => {
  cleanup();
  opened.splice(0).forEach((close) => close());
});

describe("where a toast lands", () => {
  it("takes the bottom corner when nothing is over the page", () => {
    mounted();

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("bottom-4");
    expect(trayClasses()).not.toContain("top-4");
  });

  it("moves to the top over a sheet, and stays above the scrim", () => {
    mounted();
    openSheet();

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("top-4");
    expect(trayClasses(), "the sheet's action row is exactly here").not.toContain("bottom-4");
    // The point of moving rather than dropping a layer — a toast behind the scrim is unreadable
    expect(trayClasses()).toContain("z-50");
  });

  it("moves a toast that was already up when the sheet opened", () => {
    mounted();
    act(() => raise("Saved"));
    expect(trayClasses()).toContain("bottom-4");

    openSheet();

    expect(trayClasses()).toContain("top-4");
  });

  it("takes the corner back once the last sheet closes", () => {
    mounted();
    openSheet();
    act(() => raise("Saved"));
    expect(trayClasses()).toContain("top-4");

    act(() => opened.splice(0).forEach((close) => close()));

    expect(trayClasses()).toContain("bottom-4");
    expect(trayClasses()).not.toContain("top-4");
  });

  // The two above drive the registry by hand. These two drive the component that decides which
  // kind it is, because `sheet: !bare` is the whole difference and nothing else pins it.
  it("moves for a real Modal", () => {
    render(
      <ToastProvider>
        <Raiser />
        <Modal open onClose={() => {}} title="Delete task">
          <p>are you sure</p>
        </Modal>
      </ToastProvider>
    );

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("top-4");
  });

  // A pinned bar is the other thing standing in that corner, and it is not a layer: the toast
  // steps over it the way the PM launcher does, through the attributes the bars already set.
  it("steps over a pinned bottom bar rather than sitting on it", () => {
    mounted();

    act(() => raise("Failed to post comment"));

    const classes = trayClasses();
    expect(classes).toContain("[body:has([data-pinned-bottom-bar])_&]:bottom-40");
    expect(classes).toContain("max-lg:[body:has([data-pinned-phone-bar])_&]:bottom-40");
  });

  // A full-screen `bare` dialog has no action row at the bottom; its controls are the back and
  // overflow buttons at the *top*, which is where this used to send the toast (BP-590 review)
  it("stays in the corner under a real bare Modal", () => {
    render(
      <ToastProvider>
        <Raiser />
        <Modal open onClose={() => {}} title="TP-3" bare>
          <p>the task</p>
        </Modal>
      </ToastProvider>
    );

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("bottom-4");
    expect(trayClasses()).not.toContain("top-4");
  });

  it("stays in the corner under a full-screen dialog", () => {
    mounted();
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => {
      opened.push(registerLayer(el));
    });

    act(() => raise("Saved"));

    expect(trayClasses()).toContain("bottom-4");
    expect(trayClasses()).not.toContain("top-4");
  });
});
