// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { closeOpenLayers, openLayerCount, registerLayer, subscribeLayers } from "@/lib/focus-trap";

/**
 * BP-590. The toast reads this registry to decide which corner it takes, and it is painted
 * outside every layer — so opening or closing one has to say so, or a toast already on screen
 * stays over the sheet's action row until some unrelated render moves it.
 */
describe("watching the open layers", () => {
  it("tells a watcher when a layer opens and when it closes", () => {
    const seen: number[] = [];
    const stop = subscribeLayers(() => seen.push(openLayerCount()));

    const close = registerLayer(document.createElement("div"), { close: () => {} });
    expect(seen, "opening a layer is announced").toEqual([1]);

    close();
    expect(seen, "and so is closing it").toEqual([1, 0]);

    stop();
    registerLayer(document.createElement("div"), { close: () => {} })();
    expect(seen, "a watcher that unsubscribed hears nothing more").toEqual([1, 0]);
  });

  it("keeps other watchers when one unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeLayers(first);
    const stopSecond = subscribeLayers(second);

    stopFirst();
    registerLayer(document.createElement("div"), { close: () => {} })();

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
describe("asking the open layers to close", () => {
  function layer(close?: () => void | boolean, trigger?: () => HTMLElement | null) {
    const el = document.createElement("div");
    document.body.append(el);
    return { el, stop: registerLayer(el, { close: close ?? (() => {}), trigger }) };
  }

  // All of them, top down: layers nest — a confirm opened from the task modal is two — and closing
  // only the topmost would leave the palette stacked on the parent, which is the state BP-560
  // exists to prevent
  it("walks the whole stack, top down", () => {
    const order: string[] = [];
    const a = layer(() => void order.push("under"));
    const b = layer(() => void order.push("over"));

    expect(closeOpenLayers()).not.toBe(false);

    expect(order).toEqual(["over", "under"]);
    a.stop();
    b.stop();
  });

  it("stops at a refusal, leaving the layers below it alone", () => {
    const under = vi.fn();
    const a = layer(under);
    const b = layer(() => false);

    expect(closeOpenLayers()).toBe(false);

    expect(under, "the parent is not closed on the way past a refusal").not.toHaveBeenCalled();
    a.stop();
    b.stop();
  });

  // Escaping a native keydown listener, a throw kills the shortcut for the rest of the session
  it("treats a layer that throws on the way out as a refusal", () => {
    const under = vi.fn();
    const a = layer(under);
    const b = layer(() => {
      throw new Error("mid-teardown");
    });

    expect(closeOpenLayers()).toBe(false);

    expect(under).not.toHaveBeenCalled();
    a.stop();
    b.stop();
  });

  it("reports a refusal, so the caller can leave the layer alone", () => {
    const { stop } = layer(() => false);
    expect(closeOpenLayers()).toBe(false);
    stop();
  });

  it("says yes, and hands nothing back, when there is no layer at all", () => {
    expect(closeOpenLayers()).toBeNull();
  });

  // What the replacement returns the focus to when it closes in turn: the deepest layer's own
  // trigger, since the layers above it were focused from inside the one below (BP-567 review)
  it("hands back the deepest layer's trigger", () => {
    const card = document.createElement("button");
    document.body.append(card);
    const a = layer(undefined, () => card);
    const b = layer(undefined, () => null);

    expect(closeOpenLayers()).toBe(card);

    a.stop();
    b.stop();
    card.remove();
  });

  it("forgets a layer's close when it unregisters", () => {
    const close = vi.fn();
    const { stop } = layer(close);
    stop();

    expect(closeOpenLayers()).not.toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
