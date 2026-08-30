"use client";

import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close a panel may come to the edge of the screen before it is pulled back */
const GUTTER = 12;

/**
 * Keeps an absolutely-positioned popover on the screen.
 *
 * A popover anchored to its button — `right-0` or `left-0` — is only ever correct while that button
 * sits where the anchor assumes. In the board's toolbar it does not: the row is `flex flex-wrap`,
 * so whether a control is at the left or the right edge depends on the width, on the sort control's
 * current label, and on whether the board is read-only. Measured on the two panels this has bitten:
 * the Columns picker (last in the row) opened 128px past the LEFT edge at 375px, and its first fix
 * — flipping to `left-0` — opened it 73-113px past the RIGHT edge at 390-480px, where the row no
 * longer wraps. The Filters panel (first in the row) opened 242px past the left edge at every width
 * below 640, showing 98 of its 340.
 *
 * No breakpoint can express this, because the button's position is not a function of the viewport
 * width. So the panel is measured once it is on screen and shifted back inside.
 *
 * Measured again whenever the answer could have changed, which is not only on open:
 *
 * - **The viewport.** Both panels' anchors flip side at `sm`. Open Filters in landscape on a phone
 *   (≥ sm, `left-0`, no shift), rotate to portrait (< sm, `right-0`) and the raw left is -242 again
 *   with a stale shift of 0 — the original defect, verbatim, until the panel is closed and reopened.
 * - **The anchor's own width**, which this panel's primary interaction changes. Measured at 375:
 *   picking a priority adds the count badge to the Filters button, its right edge goes 98 → 120,
 *   and the panel travels 22px with it. `offsetParent` is the `relative` wrapper both callers put
 *   round the button, so one observer covers it without widening this API.
 *
 * The re-measure subtracts the shift already applied. Reading the transformed rect and clamping
 * that again compounds: each pass would move the panel by the amount the last pass had already
 * moved it.
 */
export function usePanelClamp(open: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  style: { transform: string } | undefined;
} {
  const ref = useRef<HTMLDivElement>(null);
  const applied = useRef(0);
  const [shiftX, setShiftX] = useState(0);

  const measure = useCallback(() => {
    const box = ref.current?.getBoundingClientRect();
    // No layout to read — a test environment without one, or a panel not yet painted. A zero rect
    // would otherwise read as "12px past the left edge" and shift a panel that is nowhere.
    if (!box || box.width === 0) return;

    const left = box.left - applied.current;
    const right = box.right - applied.current;
    const past = right - (window.innerWidth - GUTTER);
    const short = GUTTER - left;
    // Left edge first: a panel wider than the screen cannot satisfy both, and a reader can scroll
    // to what runs off the right while nothing reaches what runs off the left.
    applied.current = short > 0 ? short : past > 0 ? -past : 0;
    setShiftX(applied.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      applied.current = 0;
      setShiftX(0);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const anchor = ref.current?.offsetParent;
    const observer = anchor ? new ResizeObserver(measure) : null;
    if (anchor && observer) observer.observe(anchor);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [open, measure]);

  return { ref, style: shiftX ? { transform: `translateX(${shiftX}px)` } : undefined };
}
