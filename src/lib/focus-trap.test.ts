// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { openLayerCount, registerLayer, subscribeLayers } from "@/lib/focus-trap";

/**
 * BP-590. The toast reads this registry to decide which corner it takes, and it is painted
 * outside every layer — so opening or closing one has to say so, or a toast already on screen
 * stays over the sheet's action row until some unrelated render moves it.
 */
describe("watching the open layers", () => {
  it("tells a watcher when a layer opens and when it closes", () => {
    const seen: number[] = [];
    const stop = subscribeLayers(() => seen.push(openLayerCount()));

    const close = registerLayer(document.createElement("div"));
    expect(seen, "opening a layer is announced").toEqual([1]);

    close();
    expect(seen, "and so is closing it").toEqual([1, 0]);

    stop();
    registerLayer(document.createElement("div"))();
    expect(seen, "a watcher that unsubscribed hears nothing more").toEqual([1, 0]);
  });

  it("keeps other watchers when one unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeLayers(first);
    const stopSecond = subscribeLayers(second);

    stopFirst();
    registerLayer(document.createElement("div"))();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });
});
