// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { registerLayer } from "@/lib/focus-trap";

/**
 * BP-590. A phone's dialog is a bottom sheet, and `bottom-4 right-4` at `max-w-sm` is its action
 * row. What is asserted here is which corner the tray claims, because the geometry is the fix.
 */

let raise: (message: string) => void;

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
  return screen.getByTestId("toast-tray");
}

afterEach(cleanup);

describe("where a toast lands", () => {
  it("takes the bottom corner when nothing is over the page", () => {
    mounted();

    act(() => raise("Saved"));

    expect(tray().className).toContain("bottom-4");
    expect(tray().className).not.toContain("top-4");
  });

  it("moves to the top while a layer is open, and stays above the scrim", () => {
    mounted();
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    act(() => {
      registerLayer(layer);
    });

    act(() => raise("Saved"));

    expect(tray().className).toContain("top-4");
    // Not `bottom-4` at any width below sm: that is the sheet's action row
    expect(tray().className.split(" ")).not.toContain("bottom-4");
    // The point of moving rather than dropping a layer — a toast behind the scrim is unreadable
    expect(tray().className).toContain("z-50");
  });

  it("moves a toast that was already up when the dialog opened", () => {
    mounted();
    act(() => raise("Saved"));
    expect(tray().className).toContain("bottom-4");

    const layer = document.createElement("div");
    document.body.appendChild(layer);
    act(() => {
      registerLayer(layer);
    });

    expect(tray().className).toContain("top-4");
  });

  it("takes the corner back once the last layer closes", () => {
    mounted();
    const layer = document.createElement("div");
    document.body.appendChild(layer);
    let close!: () => void;
    act(() => {
      close = registerLayer(layer);
    });
    act(() => raise("Saved"));

    act(() => close());

    expect(tray().className).toContain("bottom-4");
  });
});
