"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function hasMoreRight(el: HTMLElement): boolean {
  return el.scrollWidth - el.scrollLeft - el.clientWidth > 1;
}

/**
 * Whether a horizontal scroller still has content to the right of what it shows.
 *
 * Scrollbars are hidden app-wide (`globals.css`, BP-224), so a wide table gives the reader no sign
 * at all that it continues — which is how the fleet's Lock switch spent a release off the right
 * edge of a laptop (BP-642). The caller draws the sign; this answers when to.
 *
 * A callback ref, not a `useRef` handed to an effect: the caller renders the scroller only once
 * its rows have loaded, so an effect that ran on the first render would find no node and — with
 * nothing in its dependencies to change — never look again.
 */
export function useHorizontalOverflow<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  moreRight: boolean;
} {
  const [moreRight, setMoreRight] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback((node: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;

    const measure = () => setMoreRight(hasMoreRight(node));
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

  return { ref, moreRight };
}
