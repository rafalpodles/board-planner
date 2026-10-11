type Row = Record<string, unknown>;
type Filter = Record<string, unknown>;

const same = (a: unknown, b: unknown) => String(a) === String(b);

function matchesValue(actual: unknown, wanted: unknown): boolean {
  if (wanted && typeof wanted === "object" && !Array.isArray(wanted) && !(wanted instanceof Date)) {
    const condition = wanted as Record<string, unknown>;
    if ("$in" in condition) return (condition.$in as unknown[]).some((w) => matchesValue(actual, w));
    if ("$ne" in condition) return !matchesValue(actual, condition.$ne);
    if ("$regex" in condition) {
      return new RegExp(String(condition.$regex), String(condition.$options ?? "")).test(String(actual ?? ""));
    }
  }
  if (Array.isArray(actual)) return actual.some((item) => same(item, wanted));
  return same(actual, wanted);
}

export function matches(row: Row, filter: Filter): boolean {
  return Object.entries(filter).every(([key, wanted]) => {
    if (key === "$or") return (wanted as Filter[]).some((branch) => matches(row, branch));
    return matchesValue(row[key], wanted);
  });
}

/**
 * A scoped database held in memory, whose filters really select: a fake that returns its seed
 * whatever it is asked cannot tell a query on the right person from one on everybody. Understands
 * equality, $or, $in, $ne and $regex, and $set / $pull in updates.
 */
export function memoryDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]));
  const calls: { model: string; op: string; filter: Filter; options?: unknown }[] = [];
  const rowsOf = (name: string) => (store[name] ??= []);

  const apply = (row: Row, update: Record<string, Record<string, unknown>>) => {
    for (const [field, value] of Object.entries(update.$set ?? {})) row[field] = value;
    for (const [field, value] of Object.entries(update.$pull ?? {})) {
      row[field] = (row[field] as unknown[]).filter((item) => !same(item, value));
    }
  };

  const model = (name: string) => ({
    find: (filter: Filter = {}) => {
      calls.push({ model: name, op: "find", filter });
      const found = rowsOf(name).filter((row) => matches(row, filter)).map((row) => ({ ...row }));
      const chain = { select: () => chain, sort: () => chain, lean: async () => found };
      return chain;
    },
    findById: (id: unknown) => {
      calls.push({ model: name, op: "findById", filter: { _id: id } });
      const found = rowsOf(name).find((row) => same(row._id, id));
      const chain = { select: () => chain, lean: async () => (found ? { ...found } : null) };
      return chain;
    },
    deleteMany: async (filter: Filter) => {
      calls.push({ model: name, op: "deleteMany", filter });
      store[name] = rowsOf(name).filter((row) => !matches(row, filter));
    },
    updateOne: async (filter: Filter, update: Record<string, Record<string, unknown>>, options?: unknown) => {
      calls.push({ model: name, op: "updateOne", filter, options });
      const row = rowsOf(name).find((r) => matches(r, filter));
      if (row) apply(row, update);
    },
    updateMany: async (filter: Filter, update: Record<string, Record<string, unknown>>, options?: unknown) => {
      calls.push({ model: name, op: "updateMany", filter, options });
      for (const row of rowsOf(name).filter((r) => matches(r, filter))) apply(row, update);
    },
  });

  const models = new Map<string, ReturnType<typeof model>>();
  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => {
      if (!models.has(name)) models.set(name, model(name));
      return models.get(name);
    },
  });
  return { db: db as never, store, calls, rows: (name: string) => rowsOf(name) };
}
