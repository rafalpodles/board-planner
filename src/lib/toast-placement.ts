/**
 * Where a toast may stand.
 *
 * Four constants were tried before this and each failed a different viewport (BP-590, BP-596): the
 * corner is shared with a pinned bar, the PM launcher and the PM panel, and where those are is
 * computed — `bottom-6`, `100vh - 8rem`, `min(30rem, 100vw - 2rem)`. A fixed offset chosen against
 * one measurement of them is only right at that measurement.
 *
 * So this reads them. Pure arithmetic on rectangles, so it can be tested without a browser.
 *
 * The open panel is deliberately *not* one of them. Standing the tray in its transcript, below its
 * own header, was written first and then removed: with the launcher measured the tray already
 * clears the panel's controls at every viewport that broke a constant, so the branch was a second
 * rule nothing could justify.
 */

export interface Box {
  top: number;
  bottom: number;
}

export interface Surroundings {
  viewportHeight: number;
  /** Anything sharing the tray's corner: the launcher, a pinned bar */
  obstacles: Box[];
  /** A dialog's action row is the corner on a phone, and the top is free — BP-590 */
  overASheet: boolean;
}

/** What the tray is told to do: anchor to the bottom, to the top, or centre itself at the top */
export type Placement =
  | { anchor: "bottom"; offset: number }
  | { anchor: "top"; offset: number };

const GAP = 16;
export function placeToast(around: Surroundings): Placement {
  if (around.overASheet) return { anchor: "top", offset: GAP };

  const highest = around.obstacles.reduce(
    (top, box) => Math.min(top, box.top),
    around.viewportHeight
  );
  return { anchor: "bottom", offset: Math.max(GAP, around.viewportHeight - highest + GAP) };
}
