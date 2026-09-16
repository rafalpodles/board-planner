/**
 * Runs `task` over `items` with at most `limit` running at once. The first `limit` start before this
 * returns its promise, so a caller that fires and forgets still sees them begin immediately.
 */
export function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch {
        // One failed delivery must not stop the rest of the queue
      }
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => {});
}

/** Outbound requests one event may have open at once, per kind of destination */
export const OUTBOUND_CONCURRENCY = 4;
