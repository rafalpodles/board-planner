import { describe, it, expect } from "vitest";
import { BOARD_GAP_PX } from "./board-grid";
import {
  SWIPE_MIN_DISTANCE_PX,
  pagedColumnAt,
  pagedColumnOffset,
  pagedGridTemplate,
  stepColumn,
  swipeStep,
} from "./board-swipe";

const FAR = SWIPE_MIN_DISTANCE_PX + 20;

describe("swipeStep", () => {
  it("moves forward when the finger travels left, and back when it travels right", () => {
    expect(swipeStep(-FAR, 0)).toBe(1);
    expect(swipeStep(FAR, 0)).toBe(-1);
  });

  it("ignores a flick too short to be meant", () => {
    expect(swipeStep(-(SWIPE_MIN_DISTANCE_PX - 1), 0)).toBe(0);
    expect(swipeStep(0, 0)).toBe(0);
  });

  it("ignores a gesture that is mostly vertical", () => {
    expect(swipeStep(-FAR, FAR)).toBe(0);
    expect(swipeStep(FAR, -FAR)).toBe(0);
  });

  it("still counts a long sideways drag that drifts a little", () => {
    expect(swipeStep(-200, 40)).toBe(1);
  });

  it("ignores an incidental drag: 57px at 32 degrees is a thumb being repositioned", () => {
    expect(swipeStep(48, 30)).toBe(0);
    expect(swipeStep(-48, -30)).toBe(0);
  });

  it("wants a real flick: 63px is not one, 65px is", () => {
    expect(swipeStep(-63, 0)).toBe(0);
    expect(swipeStep(-65, 0)).toBe(1);
  });

  it("wants it roughly sideways: 100px across and 60 down is not a swipe, 40 down is", () => {
    expect(swipeStep(-100, 60)).toBe(0);
    expect(swipeStep(-100, 40)).toBe(1);
  });

  it("refuses a gesture that turned around, whichever way it went first", () => {
    expect(swipeStep(50, 0, -300)).toBe(0);
    expect(swipeStep(-50, 0, 300)).toBe(0);
  });

  it("still counts a flick that eased back a little without turning", () => {
    expect(swipeStep(-80, 0, -120)).toBe(1);
    expect(swipeStep(80, 0, 120)).toBe(-1);
  });
});

describe("stepColumn", () => {
  it("walks the columns in board order", () => {
    expect(stepColumn(0, 1, 4)).toBe(1);
    expect(stepColumn(2, -1, 4)).toBe(1);
  });

  it("stops at both ends rather than looping", () => {
    expect(stepColumn(0, -1, 4)).toBe(0);
    expect(stepColumn(3, 1, 4)).toBe(3);
  });

  it("survives a board with no columns", () => {
    expect(stepColumn(0, 1, 0)).toBe(0);
  });
});

describe("paged geometry", () => {
  it("puts every column one page and one gap further along", () => {
    expect(pagedColumnOffset(0, 390)).toBe(0);
    expect(pagedColumnOffset(2, 390)).toBe(2 * (390 + BOARD_GAP_PX));
  });

  it("reads the column back from where the row is scrolled to", () => {
    const page = 390;
    expect(pagedColumnAt(pagedColumnOffset(3, page), page, 7)).toBe(3);
    expect(pagedColumnAt(pagedColumnOffset(3, page) - 20, page, 7)).toBe(3);
  });

  it("never names a column the board does not have", () => {
    expect(pagedColumnAt(99_999, 390, 3)).toBe(2);
    expect(pagedColumnAt(-50, 390, 3)).toBe(0);
  });

  it("answers 0 for a row that has not been measured yet", () => {
    expect(pagedColumnAt(0, 0, 5)).toBe(0);
  });

  it("makes each column exactly one screen wide", () => {
    expect(pagedGridTemplate(7)).toBe("repeat(7, 100%)");
  });
});
