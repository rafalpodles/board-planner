import { Types, type Schema } from "mongoose";

export class OrganisationWallError extends Error {
  constructor(what: string) {
    super(`${what}. Every query on an organisation's data names exactly that organisation.`);
    this.name = "OrganisationWallError";
  }
}

type Marks = { expected: WeakMap<object, Types.ObjectId>; crossing: WeakMap<object, string> };
// Shared across Next's copies of this module: Mongoose keeps only the hooks of the copy that registered first
const MARKS = Symbol.for("board-planner.organisation-wall");
const shared = globalThis as typeof globalThis & { [MARKS]?: Marks };
const { expected, crossing } = (shared[MARKS] ??= { expected: new WeakMap(), crossing: new WeakMap() });

const isMarkable = (value: unknown): value is object => (typeof value === "object" || typeof value === "function") && value !== null;

export function expectOrganisation<Q>(query: Q, organisation: Types.ObjectId): Q {
  if (isMarkable(query)) expected.set(query, organisation);
  return query;
}

export function acrossOrganisations<Q>(query: Q, reason: string): Q {
  if (!reason.trim()) throw new Error("A query that crosses organisations says why");
  if (isMarkable(query)) crossing.set(query, reason);
  return query;
}

type Doc = Record<string, unknown>;

const isDoc = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Types.ObjectId);

function asId(value: unknown): Types.ObjectId | null {
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === "string" && Types.ObjectId.isValid(value) && value.length === 24) return new Types.ObjectId(value);
  return null;
}

function equalities(filter: unknown): unknown[] {
  if (!isDoc(filter)) return [];
  const found: unknown[] = [];
  if ("organisation" in filter) {
    const value = filter.organisation;
    found.push(isDoc(value) && Object.keys(value).length === 1 && "$eq" in value ? value.$eq : value);
  }
  if (Array.isArray(filter.$and)) for (const clause of filter.$and) found.push(...equalities(clause));
  return found;
}

function check(filter: unknown, want: Types.ObjectId | undefined, what: string): void {
  const named = equalities(filter);
  if (!named.length) throw new OrganisationWallError(`${what} names no organisation`);
  const ids = named.map(asId);
  if (ids.some((id) => id === null)) throw new OrganisationWallError(`${what} names its organisation by something other than one id`);
  if (want && ids.some((id) => !id!.equals(want))) throw new OrganisationWallError(`${what} names another organisation than the one it was scoped to`);
}

const FOREIGN_STAGES = ["$lookup", "$graphLookup", "$unionWith", "$merge", "$out"];

function foreignStage(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = foreignStage(item);
      if (found) return found;
    }
    return null;
  }
  if (!isDoc(node)) return null;
  for (const [key, value] of Object.entries(node)) {
    if (FOREIGN_STAGES.includes(key)) return key;
    const found = foreignStage(value);
    if (found) return found;
  }
  return null;
}

type Guarded = { getFilter(): unknown; model: { modelName: string }; op?: string };

function guardQuery(query: Guarded): void {
  if (crossing.has(query)) return;
  check(query.getFilter(), expected.get(query), `A ${query.op ?? "query"} on ${query.model.modelName}`);
}

type GuardedAggregate = { pipeline(): unknown[]; model(): { modelName: string } };

function guardAggregate(aggregate: GuardedAggregate): void {
  if (crossing.has(aggregate)) return;
  const pipeline = aggregate.pipeline();
  const what = `An aggregate on ${aggregate.model().modelName}`;
  const first = pipeline[0];
  check(isDoc(first) ? first.$match : undefined, expected.get(aggregate), `${what}, in its first $match,`);
  const stage = foreignStage(pipeline);
  if (stage) throw new OrganisationWallError(`${what} reaches another collection through ${stage}`);
}

const FILTERED_BULK = ["updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne"];

function guardBulk(modelName: string, operations: unknown): void {
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    if (!isDoc(operation)) continue;
    const [name] = Object.keys(operation);
    const body = operation[name];
    if (!isDoc(body)) continue;
    const what = `A bulk ${name} on ${modelName}`;
    if (name === "insertOne") check(isDoc(body.document) ? { organisation: body.document.organisation } : undefined, undefined, what);
    else if (FILTERED_BULK.includes(name)) check(body.filter, undefined, what);
    else throw new OrganisationWallError(`${what} cannot be checked`);
  }
}

const QUERY_OPERATIONS = [
  "countDocuments",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateMany",
  "updateOne",
  "deleteMany",
  "deleteOne",
  "findOneAndDelete",
] as const;

export function organisationWall(schema: Schema): void {
  schema.set("shardKey", { organisation: 1 });
  schema.pre([...QUERY_OPERATIONS], { document: false, query: true }, function () {
    guardQuery(this as unknown as Guarded);
  });
  schema.pre("aggregate", function () {
    guardAggregate(this as unknown as GuardedAggregate);
  });
  schema.pre("bulkWrite", function (this: { modelName: string }, operations: unknown) {
    guardBulk(this.modelName, operations);
  });
}
