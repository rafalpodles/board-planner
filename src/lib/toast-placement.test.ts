import { describe, it, expect } from "vitest";
import { placeToast } from "@/lib/toast-placement";

/**
 * BP-597. The numbers here are the ones measured on the four viewports that each defeated a
 * constant, so a regression is a regression against what was actually on screen.
 */
describe("where a toast may stand", () => {
  const nothing = { viewportHeight: 800, viewportWidth: 1280, obstacles: [], overASheet: false };

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
