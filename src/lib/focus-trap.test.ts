// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  closeTopLayer,
  openLayerCount,
  registerLayer,
  subscribeLayers,
} from "@/lib/focus-trap";

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

/**
 * BP-567. `⌘K` replaces the top layer instead of stacking on it, and it does that by asking the
 * layer to close the one way it already knows — so "Escape closes the topmost" and "⌘K replaces
 * it" cannot drift apart.
 */
describe("asking the top layer to close", () => {
  function layer(close?: () => void | boolean) {
    const el = document.createElement("div");
    document.body.append(el);
    return { el, stop: registerLayer(el, close ? { close } : {}) };
  }

  it("asks the topmost, not the first registered", () => {
    const under = vi.fn();
    const over = vi.fn();
    const a = layer(under);
    const b = layer(over);

    expect(closeTopLayer()).toBe(true);

    expect(over).toHaveBeenCalledTimes(1);
    expect(under, "the layer below is not touched").not.toHaveBeenCalled();
    a.stop();
    b.stop();
  });

  it("reports a refusal, so the caller can leave the layer alone", () => {
    const { stop } = layer(() => false);
    expect(closeTopLayer()).toBe(false);
    stop();
  });

  it("treats a layer with no close of its own as gone", () => {
    const { stop } = layer();
    expect(closeTopLayer()).toBe(true);
    stop();
  });

  it("says yes when there is no layer at all", () => {
    expect(closeTopLayer()).toBe(true);
  });

  it("forgets a layer's close when it unregisters", () => {
    const close = vi.fn();
    const { stop } = layer(close);
    stop();

    expect(closeTopLayer()).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
});
