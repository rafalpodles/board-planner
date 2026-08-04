export type DropEdge = "before" | "after";

/** Which half of the hovered row the pointer sits in, so the drop lands between rows. */
export function dropEdge(clientY: number, rect: { top: number; height: number }): DropEdge {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/**
 * Index `from` must move to so it ends up on `edge` of `target`. Shifts down by one
 * when the item is dragged forwards, since removing it first pulls the gap back.
 */
export function destinationIndex(from: number, target: number, edge: DropEdge): number {
  const to = edge === "before" ? target : target + 1;
  return from < to ? to - 1 : to;
}

/** Moves one item, leaving every other item's relative order alone. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;
  if (to < 0 || to >= items.length) return items;

  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
