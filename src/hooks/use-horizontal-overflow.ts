"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function hasMoreRight(el: HTMLElement): boolean {
  return el.scrollWidth - el.scrollLeft - el.clientWidth > 1;
}

/**
 * What a horizontal scroller is showing: whether content still lies to its right, and how much
 * room it has.
 *
 * Scrollbars are hidden app-wide (`globals.css`, BP-224), so a wide table gives the reader no sign
 * at all that it continues — which is how the fleet's Lock switch spent a release off the right
 * edge of a laptop (BP-642). The caller draws the sign; this answers when to.
 *
 * `width` is reported because a caller pinning a column has to know what it is pinning it beside:
 * a breakpoint answers how wide the WINDOW is, and the scrollport here is the window less a
 * sidebar and a settings nav — 468px at `lg`, where a 232px column would take half the table.
 *
 * A callback ref, not a `useRef` handed to an effect: the caller renders the scroller only once
 * its rows have loaded, so an effect that ran on the first render would find no node and — with
 * nothing in its dependencies to change — never look again.
 *
 * Nothing is reset when the node detaches: the values stay as last measured until a node
 * re-attaches and measures again. Harmless for a caller that mounts its scroller once and keeps
 * it; a caller that hides it and goes on rendering — a tab, an accordion — reads the previous
 * scroller's width for one frame, and decides layout on it.
 */
export function useHorizontalOverflow<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  moreRight: boolean;
  width: number;
} {
  const [state, setState] = useState({ moreRight: false, width: 0 });
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback((node: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;

    const measure = () =>
      setState((prev) => {
        const next = { moreRight: hasMoreRight(node), width: node.clientWidth };
        return prev.moreRight === next.moreRight && prev.width === next.width ? prev : next;
      });
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    // Both: the scrollport changes with the window, the content with the rows that arrive in it
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);

    cleanup.current = () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  return { ...state, ref };
}
