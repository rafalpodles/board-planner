import { describe, it, expect } from "vitest";
import { placeToast } from "@/lib/toast-placement";

/**
 * BP-597. The numbers here are the ones measured on the four viewports that each defeated a
 * constant, so a regression is a regression against what was actually on screen.
 */
describe("where a toast may stand", () => {
  // 44 is one line of toast with its padding, which is what every number below was measured
  // against — so a test that does not care about the height reads as it did before BP-624.
  const nothing = {
    viewportHeight: 800,
    viewportWidth: 1280,
    obstacles: [],
    trayHeight: 44,
    overASheet: false,
  };

  it("keeps the corner when the corner is empty", () => {
    expect(placeToast(nothing)).toEqual({ anchor: "bottom", offset: 16 });
  });

  // Measured 1280×800 on a task page: the launcher is 720–776 and the tray was 740–784, so
  // `elementFromPoint` at the launcher's centre answered "the toast"
  it("stands above the launcher rather than on it", () => {
    const placed = placeToast({ ...nothing, obstacles: [{ top: 720, bottom: 776 }] });

    // 96 = 800 - 720 + 16: the tray's bottom edge sits a gap above the launcher's top
    expect(placed).toEqual({ anchor: "bottom", offset: 96 });
  });

  it("clears the highest of several, not the last one it looked at", () => {
    const placed = placeToast({
      ...nothing,
      obstacles: [
        { top: 732, bottom: 800 }, // a pinned bar
        { top: 624, bottom: 680 }, // the launcher, stepped up because of it
      ],
    });

    expect(placed).toEqual({ anchor: "bottom", offset: 192 });
  });

  // Measured 1280×800 with the panel open: the panel is 32–704, its header 45–69 and its composer
  // 633–691, while the launcher alone would put the tray at 96 — that is 660–704, on Send
  it("stands in the panel's transcript, below its own header", () => {
    expect(
      placeToast({
        ...nothing,
        panel: { box: { top: 32, bottom: 704 }, headerBottom: 69 },
        obstacles: [{ top: 720, bottom: 776 }],
      })
    ).toEqual({ anchor: "top", offset: 85 });
  });

  /**
   * BP-623. The old fixture put the panel at 32-100 against an 800px viewport, where the corner is
   * six hundred pixels below the panel and no arrangement of this branch could collide with it —
   * so it passed while the tray was being put back on the composer.
   *
   * The numbers are a 215px viewport, worked out rather than picked: the panel is
   * `min(44rem, 100vh - 8rem)` from `top-8`, so it is 32-119 and its header still ends at 69,
   * leaving 50px under the header where a one-line tray needs 60. The launcher sits `bottom-6`, so
   * 135-191. Standing above the launcher alone puts the tray at 75-119 — inside the panel and over
   * its composer, which is the arrangement BP-597 exists to prevent, reached from the other side.
   */
  it("does not put the tray back on the panel it could not stand in", () => {
    const panelBottom = 119;
    const headerBottom = 69;
    const placed = placeToast({
      ...nothing,
      viewportHeight: 215,
      panel: { box: { top: 32, bottom: panelBottom }, headerBottom },
      obstacles: [{ top: 135, bottom: 191 }],
    });

    // Where the tray's lower edge ends up. Before, 119 — flush with the panel's bottom, which is
    // where its composer is. It must not descend past the header into the transcript at all.
    const trayBottom = 215 - placed.offset;
    expect(placed.anchor).toBe("bottom");
    expect(trayBottom).toBeLessThanOrEqual(headerBottom);
  });

  it("still stands above the launcher when the panel is not there at all", () => {
    // The control: the same short viewport without a panel places by the launcher as it always did
    expect(
      placeToast({
        ...nothing,
        viewportHeight: 215,
        obstacles: [{ top: 135, bottom: 191 }],
      })
    ).toEqual({ anchor: "bottom", offset: 96 });
  });

  /**
   * BP-624. `saveAllGroups` raises several at once and one failure sentence wraps on a phone, so
   * 150-200px is ordinary. The check below used to be asked about 44 and accepted a panel that
   * could not hold what was actually there.
   */
  it("asks the panel about the tray's real height, not one line of it", () => {
    const panel = { box: { top: 32, bottom: 704 }, headerBottom: 600 };

    // 616 + 44 fits under 704, so a one-line tray stands in the transcript
    expect(placeToast({ ...nothing, panel })).toEqual({ anchor: "top", offset: 616 });
    // 616 + 160 does not, so a tall one must not be told it fits
    expect(placeToast({ ...nothing, panel, trayHeight: 160 }).anchor).toBe("bottom");
  });

  it("keeps a tall tray's top edge on the screen", () => {
    // The clamp exists for an obstacle that genuinely reaches the top of the screen. Asked about
    // 44 while the tray is 160 it allows an offset of 740, putting the tray at -100 to 60: the
    // top edge is off the top by the difference between the guess and the truth.
    //
    // The *top* edge is the one to read. The bottom edge stays on screen either way, so an
    // assertion on it passes against both numbers and proves nothing.
    const trayHeight = 160;
    const placed = placeToast({ ...nothing, trayHeight, obstacles: [{ top: 0, bottom: 700 }] });

    expect(800 - placed.offset - trayHeight).toBeGreaterThanOrEqual(0);
  });

  // BP-590: a phone's dialog is a bottom sheet and the top of the screen is what it leaves free
  it("goes to the top over a sheet, whatever else is in the corner", () => {
    expect(
      placeToast({
        ...nothing,
        viewportWidth: 390,
        overASheet: true,
        obstacles: [{ top: 720, bottom: 776 }],
      })
    ).toEqual({ anchor: "top", offset: 16 });
  });

  // Above `sm` the same dialog is centred, not a sheet, and the corner is free — what the old
  // class list's `sm:` overrides did, and what dropping them silently would have changed
  it("keeps the corner over a dialog on a wide screen", () => {
    expect(placeToast({ ...nothing, overASheet: true })).toEqual({ anchor: "bottom", offset: 16 });
  });

  // A bar that is on the page but hidden measures at the top of the screen; without a clamp the
  // tray is pushed clean off it and the message is never seen
  it("stays on screen when something reports itself at the very top", () => {
    const placed = placeToast({ ...nothing, obstacles: [{ top: 0, bottom: 0 }] });

    expect(placed).toEqual({ anchor: "bottom", offset: 740 });
    expect(placed.offset + 44, "the tray's own top edge is still on screen").toBeLessThanOrEqual(800);
  });
});
