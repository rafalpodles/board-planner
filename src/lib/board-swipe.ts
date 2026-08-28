import { BOARD_GAP_PX } from "./board-grid";

// Below this the gesture is a tap or a hesitation, not a flick. Raised from 48px on review: at
// 48 a 57px drag 32 degrees off horizontal paged the board, which is an ordinary thumb
// reposition while reading — and nothing moves under the finger to warn that it counted.
export const SWIPE_MIN_DISTANCE_PX = 64;
// A gesture taller than this share of its width belongs to whatever is being scrolled
// vertically — a column's card list, or the page itself. Tightened from 0.7 (35 degrees) for
// the same reason: a deliberate flick between columns is not held at 30 degrees.
const SWIPE_MAX_SLOPE = 0.5;

export type SwipeStep = -1 | 0 | 1;

/**
 * `furthestDx` is the extreme the finger reached, not where it ended. Without it only net
 * displacement is measured, so a finger that drags 300px left to peek at the next column,
 * thinks better of it and returns — overshooting the origin by 50px on the way back — pages
 * *backward*: the opposite of both things the person did. Comparing the two says the gesture
 * turned around, and a gesture that turned around is a cancellation.
 */
export function swipeStep(dx: number, dy: number, furthestDx: number = dx): SwipeStep {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return 0;
  if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return 0;
  if (Math.sign(dx) !== Math.sign(furthestDx)) return 0;
  // Dragging leftwards pulls the next column in, the way a carousel moves
  return dx < 0 ? 1 : -1;
}

function clamp(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

/** Stops at both ends rather than wrapping: a loop hides which end of the board you are on. */
export function stepColumn(current: number, step: SwipeStep, count: number): number {
  return clamp(current + step, count);
}

/** Every column is one page wide, so the pages sit a gap apart. */
export function pagedColumnOffset(index: number, pageWidth: number): number {
  return index * (pageWidth + BOARD_GAP_PX);
}

export function pagedColumnAt(scrollLeft: number, pageWidth: number, count: number): number {
  if (pageWidth <= 0) return 0;
  return clamp(Math.round(scrollLeft / (pageWidth + BOARD_GAP_PX)), count);
}

export function pagedGridTemplate(count: number): string {
  return `repeat(${count}, 100%)`;
}
