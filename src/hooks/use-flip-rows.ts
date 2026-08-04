import { useLayoutEffect, useRef } from "react";

const DURATION_MS = 180;

/**
 * Slides rows from where they were to where they are now, so a reorder reads as
 * movement rather than a jump. Registers each row through the returned callback.
 *
 * The invert step forces a reflow instead of waiting for requestAnimationFrame:
 * rAF never fires in a hidden tab, which would strand every row mid-translate.
 */
export function useFlipRows(orderKey: string) {
  const rows = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rows.current.forEach((el, id) => next.set(id, el.getBoundingClientRect().top));

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!still) {
      next.forEach((top, id) => {
        const was = tops.current.get(id);
        const el = rows.current.get(id);
        if (was === undefined || !el || was === top) return;
        el.style.transition = "none";
        el.style.transform = `translateY(${was - top}px)`;
        void el.offsetHeight;
        el.style.transition = `transform ${DURATION_MS}ms ease`;
        el.style.transform = "";
      });
    }
    tops.current = next;
  }, [orderKey]);

  return (id: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  };
}
