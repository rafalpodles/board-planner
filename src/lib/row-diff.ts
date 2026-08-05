export interface RowDiff<T> {
  added: T[];
  removed: string[];
  changed: T[];
}

/**
 * What a drafted list of rows has to send when the API is per-row rather than a bulk PUT
 * — notification channels, outgoing webhooks.
 *
 * Order is deliberately not a change: these endpoints cannot express one, and treating a
 * drag as an edit of every row would rewrite the lot to say nothing.
 */
export function diffById<T extends { _id?: string }>(baseline: T[], next: T[]): RowDiff<T> {
  const before = new Map(baseline.filter((r) => r._id).map((r) => [r._id as string, r]));
  const keptIds = new Set(next.map((r) => r._id).filter(Boolean) as string[]);

  return {
    added: next.filter((r) => !r._id),
    removed: baseline
      .filter((r) => r._id && !keptIds.has(r._id))
      .map((r) => r._id as string),
    changed: next.filter((r) => {
      if (!r._id) return false;
      const original = before.get(r._id);
      return !!original && JSON.stringify(original) !== JSON.stringify(r);
    }),
  };
}
