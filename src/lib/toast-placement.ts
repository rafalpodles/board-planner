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
 * The open panel is the one that cannot be stood above — it reaches nearly to the top — so the
 * tray stands on it instead, between its header and its composer. Measured at 1280×800: the panel
 * is 32–704, its header 45–69 and its composer 633–691, and a tray placed only by the launcher
 * lands at 660–704, on Send.
 */

export interface Box {
  top: number;
  bottom: number;
}

export interface Surroundings {
  viewportHeight: number;
  /** Anything sharing the tray's corner: the launcher, a pinned bar */
  obstacles: Box[];
  /**
   * The open PM panel and the header its own controls sit in. Nearly the whole screen, so it is
   * not something to stand above; the tray stands *on* it, in the transcript.
   */
  panel?: { box: Box; headerBottom: number };
  /** A dialog's action row is the corner on a phone, and the top is free — BP-590 */
  overASheet: boolean;
}

/** What the tray is told to do: anchor to the bottom, to the top, or centre itself at the top */
export type Placement =
  | { anchor: "bottom"; offset: number }
  | { anchor: "top"; offset: number };

const GAP = 16;
/** The tray's own height, near enough: one line of text with its padding */
const TRAY = 44;
export function placeToast(around: Surroundings): Placement {
  if (around.overASheet) return { anchor: "top", offset: GAP };

  if (around.panel) {
    const under = around.panel.headerBottom + GAP;
    // Unless the panel is too short to hold the tray below its own header, which is not a band at
    // all; then there is room in the ordinary way.
    if (under + TRAY <= around.panel.box.bottom) return { anchor: "top", offset: under };
  }

  const highest = around.obstacles.reduce(
    (top, box) => Math.min(top, box.top),
    around.viewportHeight
  );
  return { anchor: "bottom", offset: Math.max(GAP, around.viewportHeight - highest + GAP) };
}
