"use client";

import { RefObject, useEffect, useRef } from "react";
import {
  cycleTabWithin,
  openLayerCount,
  registerLayer,
  topmostLayer,
} from "@/lib/focus-trap";

interface FocusTrapOptions {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  /** Where focus lands on close when nothing was focused at open time — keyboard shortcuts, Safari clicks */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** Off for layers that leave the page scrollable behind them */
  lockScroll?: boolean;
}

export function useFocusTrap({
  active,
  containerRef,
  onEscape,
  returnFocusTo,
  lockScroll = true,
}: FocusTrapOptions) {
  // BP-530: every caller passes an inline arrow, so a dep on it re-subscribes the keydown listener
  // whenever another handler writes state during the same dispatch — and a listener added during a
  // dispatch never sees that event. BP-522 is that bug one layer up
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current!;
    const unregister = registerLayer(container);
    if (lockScroll) document.body.style.overflow = "hidden";
    return () => {
      unregister();
      if (lockScroll && openLayerCount() === 0) document.body.style.overflow = "";
    };
  }, [active, containerRef, lockScroll]);

  useEffect(() => {
    if (!active) return;
    const focused = document.activeElement as HTMLElement | null;
    const trigger =
      focused && focused !== document.body && focused !== document.documentElement
        ? focused
        : null;
    containerRef.current!.focus();
    return () => {
      const target = trigger ?? returnFocusTo?.current ?? null;
      if (target?.isConnected) target.focus();
    };
  }, [active, containerRef, returnFocusTo]);

  useEffect(() => {
    if (!active) return;
    function handleKey(e: KeyboardEvent) {
      const container = containerRef.current;
      if (!container || topmostLayer() !== container) return;
      if (e.key === "Escape") {
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      cycleTabWithin(container, e);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [active, containerRef]);
}
