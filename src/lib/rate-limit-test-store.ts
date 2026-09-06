type Row = { _id: string; count: number; resetAt: Date };
type Filter = { _id?: string; resetAt?: { $gt: Date } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any;
type Update =
  | { $inc?: { count: number }; $set?: { count: number; resetAt: Date } }
  | Array<{ $set: Record<string, Expr> }>;

function evaluate(expr: Expr, doc: Record<string, unknown>): unknown {
  if (typeof expr === "string" && expr.startsWith("$")) return doc[expr.slice(1)];
  if (!expr || typeof expr !== "object" || expr instanceof Date) return expr;

  if ("$cond" in expr) {
    const [test, whenTrue, whenFalse] = expr.$cond as [Expr, Expr, Expr];
    return evaluate(test, doc) ? evaluate(whenTrue, doc) : evaluate(whenFalse, doc);
  }
  if ("$gt" in expr) {
    const [left, right] = (expr.$gt as [Expr, Expr]).map((side) => evaluate(side, doc));
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
    async deleteMany(filter?: Filter) {
      const range = filter?._id as { $gte?: string; $lt?: string } | string | undefined;
      if (range && typeof range === "object" && ("$gte" in range || "$lt" in range)) {
        let deleted = 0;
        for (const id of [...rows.keys()]) {
          const atOrAfterStart = range.$gte === undefined || id >= range.$gte;
          const beforeEnd = range.$lt === undefined || id < range.$lt;
          if (atOrAfterStart && beforeEnd) {
            rows.delete(id);
            deleted++;
          }
        }
        return { deletedCount: deleted };
      }
      if (typeof range === "string") {
        const deleted = rows.delete(range) ? 1 : 0;
        return { deletedCount: deleted };
      }
      const all = rows.size;
      rows.clear();
      return { deletedCount: all };
    },
  };
}
