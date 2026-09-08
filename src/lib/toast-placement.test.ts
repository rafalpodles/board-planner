import { describe, it, expect } from "vitest";
import { placeToast } from "@/lib/toast-placement";

/**
 * BP-597. The numbers here are the ones measured on the four viewports that each defeated a
 * constant, so a regression is a regression against what was actually on screen.
 */
describe("where a toast may stand", () => {
  const nothing = { viewportHeight: 800, obstacles: [], overASheet: false };

  it("keeps the corner when the corner is empty", () => {
    expect(placeToast(nothing)).toEqual({ anchor: "bottom", offset: 16 });
  });

  // Measured 1280×800 on a task page: the launcher is 720–776 and the tray was 740–784, so
  // `elementFromPoint` at the launcher's centre answered "the toast"
  it("stands above the launcher rather than on it", () => {
    const placed = placeToast({ ...nothing, obstacles: [{ top: 720, bottom: 776 }] });

    expect(placed).toEqual({ anchor: "bottom", offset: 96 });
    // The tray's own top edge, checked against the thing it had to clear
    expect(800 - 96 - 44).toBeLessThan(720);
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
      placeToast({ ...nothing, overASheet: true, obstacles: [{ top: 720, bottom: 776 }] })
    ).toEqual({ anchor: "top", offset: 16 });
  });
});
