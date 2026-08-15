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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any;
type Update =
  | { $inc?: { count: number }; $set?: { count: number; resetAt: Date } }
  | Array<{ $set: Record<string, Expr> }>;

/**
 * Just enough of the aggregation expression language for the operators `rate-limit.ts` uses. A
 * field path resolves against the document as it stands after the earlier stages, which is what
 * makes `$cond` on `$resetAt` mean what Mongo means by it.
 */
function evaluate(expr: Expr, doc: Record<string, unknown>): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) return doc[expr.slice(1)];
  if (!expr || typeof expr !== "object" || expr instanceof Date) return expr;

  if ("$cond" in expr) {
    const [test, whenTrue, whenFalse] = expr.$cond as [Expr, Expr, Expr];
    return evaluate(test, doc) ? evaluate(whenTrue, doc) : evaluate(whenFalse, doc);
  }
  if ("$gt" in expr) {
    const [left, right] = (expr.$gt as [Expr, Expr]).map((side) => evaluate(side, doc));
    // Mongo compares BSON types before values, and a missing field sorts below a date — so an
    // absent resetAt is not "greater than now", which is what makes the upsert branch fire
    if (!(left instanceof Date) || !(right instanceof Date)) return false;
    return left.getTime() > right.getTime();
  }
  if ("$add" in expr) {
    return (expr.$add as Expr[]).reduce((sum, side) => sum + Number(evaluate(side, doc)), 0);
  }
  if ("$ifNull" in expr) {
    const [value, fallback] = expr.$ifNull as [Expr, Expr];
    const resolved = evaluate(value, doc);
    return resolved === undefined || resolved === null ? evaluate(fallback, doc) : resolved;
  }
  throw new Error(`rate-limit-test-store: unsupported expression ${JSON.stringify(expr)}`);
}

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
    async updateOne(filter: Filter, update: Update, options?: { upsert?: boolean }) {
      const existing = [...rows.values()].find((r) => matches(r, filter));

      if (Array.isArray(update)) {
        // An update pipeline computes the new document from the stored one, so the fake evaluates
        // the expressions the code actually sends rather than assuming what they mean. Nothing here
        // is a second implementation of the rule under test.
        const before = existing ?? (options?.upsert ? { _id: filter._id as string } : undefined);
        if (!before) return { matchedCount: 0, upsertedCount: 0 };
        const after = { ...before } as Record<string, unknown>;
        for (const stage of update) {
          for (const [field, expr] of Object.entries(stage.$set)) {
            after[field] = evaluate(expr, after);
          }
        }
        rows.set(after._id as string, after as unknown as Row);
        return existing
          ? { matchedCount: 1, upsertedCount: 0 }
          : { matchedCount: 0, upsertedCount: 1 };
      }

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
