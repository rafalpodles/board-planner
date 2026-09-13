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

/** Tailwind's `sm`, the width at which a dialog stops being a bottom sheet */
export const SHEET_BREAKPOINT = 640;

export interface Surroundings {
  viewportHeight: number;
  /**
   * The tray's own height, measured. A constant was wrong in both directions at once: the
   * panel-fit check below accepted a panel that could not hold the tray, and the clamp that exists
   * to keep the tray on screen let its top edge off the top. Several toasts at once, or one
   * failure sentence wrapping on a phone, is 150-200px rather than the 44 of one line (BP-624).
   */
  trayHeight: number;
  /** Only compared against `SHEET_BREAKPOINT`; the caller resolves it from a media query */
  viewportWidth: number;
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

/** What the tray is told to do: anchor to the bottom of the screen, or to the top */
export type Placement =
  | { anchor: "bottom"; offset: number }
  | { anchor: "top"; offset: number };

const GAP = 16;

export function placeToast(around: Surroundings): Placement {
  // Only below `sm`, because that is where a dialog *is* a bottom sheet and its action row is the
  // corner. Wider, it is centred and the corner is free — which is what the `sm:` overrides on the
  // old class list did, and dropping them silently would have moved every desktop confirm's toast
  // to the top of the screen.
  if (around.overASheet && around.viewportWidth < SHEET_BREAKPOINT) {
    return { anchor: "top", offset: GAP };
  }

  // A panel too short to hold the tray below its own header is not a band to stand in — but it is
  // still the thing the tray must not cover, so it becomes an obstacle rather than nothing at all.
  // Falling through to the corner was the defect BP-597 exists to prevent, arrived at from the
  // other side: on a short viewport the corner *is* inside the panel, over its composer (BP-623).
  //
  // This buys the composer, not the whole panel, and on a short enough viewport that is all there
  // is to buy. Standing above a panel that starts at 32 needs 32px of room, so the clamp below
  // takes over and the tray ends up against the top of the screen — which on a landscape phone
  // with several toasts up is the panel's header. Deliberate: the header carries the panel's own
  // ⤢ and ✕, the composer carries Send, and a toast over Send is the thing this file exists to
  // prevent. A viewport that short has no placement that covers nothing.
  const corner = [...around.obstacles];
  if (around.panel) {
    const under = around.panel.headerBottom + GAP;
    if (under + around.trayHeight <= around.panel.box.bottom) {
      return { anchor: "top", offset: under };
    }
    // Height-checked like every other member of this list. `measure` drops a zero-height obstacle
    // before it gets here but does not drop the panel, so without this the clamp's claim below —
    // that the caller already did it — stops being true for the one element BP-623 adds.
    if (around.panel.box.bottom > around.panel.box.top) corner.push(around.panel.box);
  }

  const highest = corner.reduce((top, box) => Math.min(top, box.top), around.viewportHeight);
  // Clamped as a last resort. The caller already drops a zero-height obstacle, so this is not the
  // defence against a hidden bar; it is what keeps an obstacle that genuinely reaches the top of
  // the screen from pushing the tray off it.
  const above = around.viewportHeight - highest + GAP;
  return {
    anchor: "bottom",
    offset: Math.min(Math.max(GAP, above), around.viewportHeight - GAP - around.trayHeight),
  };
}
