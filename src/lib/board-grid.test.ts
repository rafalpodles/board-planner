import { describe, it, expect } from "vitest";
import {
  isColumnCollapsed,
  boardGridTemplate,
  boardMinWidth,
  COLLAPSED_COLUMN_PX,
  MIN_EXPANDED_COLUMN_PX,
  BOARD_GAP_PX,
} from "./board-grid";

describe("isColumnCollapsed", () => {
  it("collapses only an empty column", () => {
    expect(isColumnCollapsed(0, false, false)).toBe(true);
    expect(isColumnCollapsed(1, false, false)).toBe(false);
    expect(isColumnCollapsed(20, false, false)).toBe(false);
  });

  it("stays expanded once pinned", () => {
    expect(isColumnCollapsed(0, true, false)).toBe(false);
  });

  it("expands while a card is dragged over it", () => {
    expect(isColumnCollapsed(0, false, true)).toBe(false);
  });

  it("never collapses a column that has tasks, whatever the other flags", () => {
    expect(isColumnCollapsed(3, true, true)).toBe(false);
    expect(isColumnCollapsed(3, false, true)).toBe(false);
  });

  it("collapses nothing once the preference is off", () => {
    expect(isColumnCollapsed(0, false, false, false)).toBe(false);
    expect(isColumnCollapsed(0, true, false, false)).toBe(false);
    expect(isColumnCollapsed(0, false, true, false)).toBe(false);
  });

  it("keeps collapsing when the preference is omitted, so callers that never pass it are unchanged", () => {
    expect(isColumnCollapsed(0, false, false)).toBe(true);
    expect(isColumnCollapsed(0, false, false, true)).toBe(true);
  });
});

describe("boardGridTemplate", () => {
  it("gives every expanded column an equal share", () => {
    expect(boardGridTemplate([false, false])).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });

  it("pins a collapsed column to the rail width", () => {
    expect(boardGridTemplate([true, false])).toBe(`${COLLAPSED_COLUMN_PX}px minmax(0, 1fr)`);
  });

  it("keeps column order", () => {
    expect(boardGridTemplate([false, true, false])).toBe(
      `minmax(0, 1fr) ${COLLAPSED_COLUMN_PX}px minmax(0, 1fr)`
    );
  });

  it("handles a board where everything is empty", () => {
    expect(boardGridTemplate([true, true])).toBe(
      `${COLLAPSED_COLUMN_PX}px ${COLLAPSED_COLUMN_PX}px`
    );
  });
});

describe("boardMinWidth", () => {
  it("reserves the full column width for expanded columns", () => {
    expect(boardMinWidth([false, false, false])).toBe(
      3 * MIN_EXPANDED_COLUMN_PX + 2 * BOARD_GAP_PX
    );
  });

  it("charges a collapsed column only the rail width", () => {
    expect(boardMinWidth([true, false])).toBe(
      COLLAPSED_COLUMN_PX + MIN_EXPANDED_COLUMN_PX + BOARD_GAP_PX
    );
  });

  it("counts the gaps, which otherwise eat into the columns", () => {
    expect(boardMinWidth([true, false, false, true, false, false, false, true])).toBe(
      3 * COLLAPSED_COLUMN_PX + 5 * MIN_EXPANDED_COLUMN_PX + 7 * BOARD_GAP_PX
    );
  });

  it("shrinks the board's scroll width as columns empty out", () => {
    const allExpanded = boardMinWidth([false, false, false, false, false, false, false]);
    const fourEmpty = boardMinWidth([true, true, true, true, false, false, false]);
    expect(fourEmpty).toBeLessThan(allExpanded);
  });

  it("adds no gap for a single column", () => {
    expect(boardMinWidth([false])).toBe(MIN_EXPANDED_COLUMN_PX);
  });

  it("is zero for a board with no columns", () => {
    expect(boardMinWidth([])).toBe(0);
  });
});
