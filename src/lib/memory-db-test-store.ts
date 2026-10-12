type Row = Record<string, unknown>;
type Filter = Record<string, unknown>;

const same = (a: unknown, b: unknown) => String(a) === String(b);

const KNOWN = new Set(["$in", "$ne", "$regex", "$options"]);

function matchesValue(actual: unknown, wanted: unknown): boolean {
  // Mongo matches null against a missing field too
  if (wanted === null) return actual === null || actual === undefined;
  if (wanted && typeof wanted === "object" && !Array.isArray(wanted) && !(wanted instanceof Date)) {
    const condition = wanted as Record<string, unknown>;
    // A query this fake cannot run must fail loudly: silently matching nothing satisfies every negative assertion
    for (const key of Object.keys(condition)) {
      if (key.startsWith("$") && !KNOWN.has(key)) throw new Error(`memoryDb does not understand ${key}`);
    }
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
    if (key.startsWith("$") && key !== "$or") throw new Error(`memoryDb does not understand ${key}`);
    if (key.includes(".")) throw new Error(`memoryDb does not understand the path ${key}`);
    if (key === "$or") return (wanted as Filter[]).some((branch) => matches(row, branch));
    return matchesValue(row[key], wanted);
  });
}

// What `.select()` asks for, so a query that forgets a field it reads is as blind here as it is in Mongo
function project(row: Row, fields: string[] | null): Row {
  if (!fields) return { ...row };
  const out: Row = { _id: row._id };
  for (const field of fields) if (field in row) out[field] = row[field];
  return out;
}

/**
 * A scoped database held in memory, whose filters really select: a fake that returns its seed
 * whatever it is asked cannot tell a query on the right person from one on everybody. Understands
 * equality, $or, $in, $ne and $regex, sort and limit on strings, distinct, and $set / $pull in updates.
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
      let fields: string[] | null = null;
      let max = Infinity;
      let order: [string, number][] = [];
      const chain = {
        select: (list: string) => {
          fields = list.split(/\s+/).filter(Boolean);
          return chain;
        },
        sort: (spec: Record<string, number> = {}) => {
          order = Object.entries(spec);
          return chain;
        },
        limit: (n: number) => {
          max = n;
          return chain;
        },
        lean: async () =>
          rowsOf(name)
            .filter((row) => matches(row, filter))
            .sort((a, b) => {
              for (const [key, direction] of order) {
                const x = String(a[key] ?? "");
                const y = String(b[key] ?? "");
                if (x !== y) return (x < y ? -1 : 1) * direction;
              }
              return 0;
            })
            .slice(0, max)
            .map((row) => project(row, fields)),
      };
      return chain;
    },
    findById: (id: unknown) => {
      calls.push({ model: name, op: "findById", filter: { _id: id } });
      const found = rowsOf(name).find((row) => same(row._id, id));
      let fields: string[] | null = null;
      const chain = {
        select: (list: string) => {
          fields = list.split(/\s+/).filter(Boolean);
          return chain;
        },
        lean: async () => (found ? project(found, fields) : null),
      };
      return chain;
    },
    distinct: async (field: string, filter: Filter = {}) => {
      calls.push({ model: name, op: "distinct", filter });
      const seen = new Map<string, unknown>();
      for (const row of rowsOf(name).filter((r) => matches(r, filter))) {
        const value = row[field];
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== null && item !== undefined) seen.set(String(item), item);
        }
      }
      return [...seen.values()];
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
