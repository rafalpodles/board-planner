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

/**
 * The id order after dragging one item onto another, or null when the drop changes
 * nothing. Kept out of the component because the drag itself belongs to dnd-kit,
 * but which order it produces is ours to get right.
 */
export function reorderedIds(ids: string[], activeId: string, overId: string): string[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  return moveItem(ids, from, to);
}

export interface ManualRow {
  id: string;
  order: number;
  createdAt: number;
  taskNumber: number;
}

/** The order the list view shows under manual sort — must match sortTasks' "manual" case. */
export function manualOrder(rows: ManualRow[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.order - b.order || b.createdAt - a.createdAt || a.taskNumber - b.taskNumber
    )
    .map((r) => r.id);
}

/**
 * Drops `moved` into the slots it already occupied within `all`, keeping every other
 * id where it was. The client can only order the rows it can see, so a filtered list
 * must not be able to shuffle the ones it cannot.
 */
export function placeInto(all: string[], moved: string[]): string[] {
  const moving = new Set(moved);
  const slots: number[] = [];
  all.forEach((id, index) => {
    if (moving.has(id)) slots.push(index);
  });
  if (slots.length !== moved.length) return all;

  const next = [...all];
  moved.forEach((id, i) => {
    next[slots[i]] = id;
  });
  return next;
}
