/**
 * An in-memory stand-in for the RateLimit collection, for tests that exercise a throttled route
 * without a database.
 *
 * It implements the three operations `rate-limit.ts` actually uses, including the `resetAt` filter
 * — a fake that ignored it would make every windowing test pass regardless of what the real query
 * says, which is the shape of fixture this codebase has already been bitten by twice.
 *
 * Lives in src/lib rather than a test file because five suites need it, and a copy per suite is a
 * copy that can drift from the query it stands in for.
 */
type Row = { _id: string; count: number; resetAt: Date };
type Filter = { _id?: string; resetAt?: { $gt: Date } };

export function inMemoryRateLimitModel() {
  const rows = new Map<string, Row>();

  const matches = (row: Row, filter: Filter) =>
    (filter._id === undefined || row._id === filter._id) &&
    (filter.resetAt === undefined || row.resetAt.getTime() > filter.resetAt.$gt.getTime());

  return {
    rows,
    findOne(filter: Filter) {
      const row = [...rows.values()].find((r) => matches(r, filter)) ?? null;
      const result = { select: () => result, lean: () => Promise.resolve(row) };
      return result;
    },
    async updateOne(
      filter: Filter,
      update: { $inc?: { count: number }; $set?: { count: number; resetAt: Date } },
      options?: { upsert?: boolean }
    ) {
      const existing = [...rows.values()].find((r) => matches(r, filter));
      if (existing) {
        if (update.$inc) existing.count += update.$inc.count;
        if (update.$set) Object.assign(existing, update.$set);
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert && filter._id !== undefined && update.$set) {
        rows.set(filter._id, { _id: filter._id, ...update.$set });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, upsertedCount: 0 };
    },
    async deleteOne(filter: Filter) {
      if (filter._id !== undefined) rows.delete(filter._id);
      return { deletedCount: 1 };
    },
    async deleteMany() {
      rows.clear();
      return { deletedCount: 0 };
    },
  };
}
