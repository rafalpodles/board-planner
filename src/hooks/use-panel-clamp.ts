"use client";

import { RefObject, useLayoutEffect, useRef, useState } from "react";

/** How close a panel may come to the edge of the screen before it is pulled back */
const GUTTER = 12;

/**
 * Keeps an absolutely-positioned popover on the screen.
 *
 * A popover anchored to its button — `right-0` or `left-0` — is only ever correct while that
 * button sits where the anchor assumes. In the board's toolbar it does not: the row is
 * `flex flex-wrap`, so whether a control is at the left or the right edge depends on the width, on
 * the sort control's current label, and on whether the board is read-only. Measured on the two
 * panels this has bitten: the Columns picker (last in the row) opened 128px past the LEFT edge at
 * 375px, and its first fix — flipping to `left-0` — opened it 73-113px past the RIGHT edge at
 * 390-480px, where the row no longer wraps. The Filters panel (first in the row) opened 242px past
 * the left edge at every width below 640, showing 98 of its 340.
 *
 * No breakpoint can express this, because the button's position is not a function of the viewport
 * width. So the panel is measured once it is on screen and shifted back inside — the same thing
 * `Combobox` does with a fixed-position portal, in the one shape an `absolute` panel can use.
 */
export function usePanelClamp(open: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  style: { transform: string } | undefined;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const past = box.right - (window.innerWidth - GUTTER);
    const short = GUTTER - box.left;
    // Left edge first: a panel wider than the screen cannot satisfy both, and a reader can scroll
    // to what runs off the right while nothing reaches what runs off the left.
    setShiftX(short > 0 ? short : past > 0 ? -past : 0);
  }, [open]);

  return { ref, style: shiftX ? { transform: `translateX(${shiftX}px)` } : undefined };
}
