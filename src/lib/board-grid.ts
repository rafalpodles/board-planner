export const COLLAPSED_COLUMN_PX = 44;
export const MIN_EXPANDED_COLUMN_PX = 200;

// A drag in progress expands the target so a card can be dropped into it.
// `enabled` is the user's preference; off, no column ever becomes a rail.
export function isColumnCollapsed(
  taskCount: number,
  pinned: boolean,
  dragOver: boolean,
  enabled = true
): boolean {
  return enabled && taskCount === 0 && !pinned && !dragOver;
}

export function boardGridTemplate(collapsed: boolean[]): string {
  return collapsed
    .map((c) => (c ? `${COLLAPSED_COLUMN_PX}px` : "minmax(0, 1fr)"))
    .join(" ");
}

export const BOARD_GAP_PX = 16;

// Without this the grid keeps reserving 200px per collapsed column and the board
// scrolls horizontally for space it is not using. The gaps have to be counted too,
// or they eat into the columns and push expanded ones below their 200px floor.
export function boardMinWidth(collapsed: boolean[]): number {
  if (collapsed.length === 0) return 0;
  const columns = collapsed.reduce(
    (sum, c) => sum + (c ? COLLAPSED_COLUMN_PX : MIN_EXPANDED_COLUMN_PX),
    0
  );
  return columns + (collapsed.length - 1) * BOARD_GAP_PX;
}
