import { BOARD_GAP_PX } from "./board-grid";

export const SWIPE_MIN_DISTANCE_PX = 64;
const SWIPE_MAX_SLOPE = 0.5;

export type SwipeStep = -1 | 0 | 1;

export function swipeStep(dx: number, dy: number, furthestDx: number = dx): SwipeStep {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return 0;
  if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return 0;
  if (Math.sign(dx) !== Math.sign(furthestDx)) return 0;
  return dx < 0 ? 1 : -1;
}

function clamp(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

export function stepColumn(current: number, step: SwipeStep, count: number): number {
  return clamp(current + step, count);
}

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
