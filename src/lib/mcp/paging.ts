export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

/**
 * A page that says how much of the whole it is. A truncated list reads as a complete one, so
 * `nextOffset` is null only when nothing follows.
 */
export function pageOf<T>(tasks: T[], total: number, offset: number) {
  const end = offset + tasks.length;
  return { total, returned: tasks.length, offset, nextOffset: end < total ? end : null, tasks };
}
