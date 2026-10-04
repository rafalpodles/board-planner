import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const model = vi.hoisted(() => {
  const methods = [
    "find", "findOne", "findOneAndUpdate", "findOneAndDelete", "updateOne", "updateMany", "deleteOne",
    "deleteMany", "countDocuments", "exists", "distinct", "create", "insertMany", "aggregate", "bulkWrite",
  ];
  const fake: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of methods) fake[name] = vi.fn();
  return fake;
});
const Constructed = vi.hoisted(() => vi.fn());

vi.mock("@/models/sprint", () => ({ Sprint: Object.assign(Constructed, model) }));

const { scoped, scopedFor, tenantOf, TenantKeyError, UnscopableError } = await import("./db-scope");
const { DEFAULT_TENANT_ID } = await import("./tenant-field");

const A = new Types.ObjectId("0000000000000000000000a1");
const db = () => scoped(A).Sprint;

beforeEach(() => {
  for (const fn of Object.values(model)) fn.mockReset();
  Constructed.mockReset();
});

describe("reads", () => {
  it("add the tenant to a filter and keep the rest of the call", () => {
    db().find({ name: "x" }, "name", { lean: true });
    expect(model.find).toHaveBeenCalledWith({ name: "x", tenant: A }, "name", { lean: true });
  });

  it("scope a call that names no filter at all", () => {
    db().find();
    db().countDocuments();
    db().exists(undefined as never);
    expect(model.find).toHaveBeenCalledWith({ tenant: A });
    expect(model.countDocuments).toHaveBeenCalledWith({ tenant: A });
    expect(model.exists).toHaveBeenCalledWith({ tenant: A });
  });

  it("turn findById into a tenant-scoped findOne, and an absent id into a miss", () => {
    const id = new Types.ObjectId();
    db().findById(id, "name");
    db().findById(undefined);
    expect(model.findOne).toHaveBeenNthCalledWith(1, { _id: id, tenant: A }, "name");
    expect(model.findOne).toHaveBeenNthCalledWith(2, { _id: null, tenant: A });
  });

  it("keep a top-level $or inside the tenant", () => {
    db().find({ $or: [{ name: "a" }, { name: "b" }] });
    expect(model.find).toHaveBeenCalledWith({ $or: [{ name: "a" }, { name: "b" }], tenant: A });
  });

  it("scope distinct's filter and leave its field alone", () => {
    db().distinct("name", { goal: "g" });
    expect(model.distinct).toHaveBeenCalledWith("name", { goal: "g", tenant: A });
  });
});

describe("writes", () => {
  it("scope the filter of every update and delete form", () => {
    const id = new Types.ObjectId();
    db().updateOne({ name: "x" }, { $set: { goal: "g" } }, { upsert: true });
    db().updateMany({}, { $set: { goal: "g" } });
    db().findOneAndUpdate({ name: "x" }, { $set: { goal: "g" } }, { new: true });
    db().findByIdAndUpdate(id, { $set: { goal: "g" } });
    db().deleteOne({ name: "x" });
    db().deleteMany({});
    db().findOneAndDelete({ name: "x" });
    db().findByIdAndDelete(id);

    expect(model.updateOne).toHaveBeenCalledWith({ name: "x", tenant: A }, { $set: { goal: "g" } }, { upsert: true });
    expect(model.updateMany).toHaveBeenCalledWith({ tenant: A }, { $set: { goal: "g" } });
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(1, { name: "x", tenant: A }, { $set: { goal: "g" } }, { new: true });
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(2, { _id: id, tenant: A }, { $set: { goal: "g" } });
    expect(model.deleteOne).toHaveBeenCalledWith({ name: "x", tenant: A });
    expect(model.deleteMany).toHaveBeenCalledWith({ tenant: A });
    expect(model.findOneAndDelete).toHaveBeenNthCalledWith(1, { name: "x", tenant: A });
    expect(model.findOneAndDelete).toHaveBeenNthCalledWith(2, { _id: id, tenant: A });
  });

  it("stamp the tenant on what create and insertMany write", () => {
    db().create({ name: "x" } as never);
    db().create([{ name: "y" }, { name: "z" }] as never);
    db().insertMany([{ name: "w" }] as never);
    expect(model.create).toHaveBeenNthCalledWith(1, { name: "x", tenant: A });
    expect(model.create).toHaveBeenNthCalledWith(2, [
      { name: "y", tenant: A },
      { name: "z", tenant: A },
    ]);
    expect(model.insertMany).toHaveBeenCalledWith([{ name: "w", tenant: A }]);
  });

  it("build constructs the model with the tenant set", () => {
    db().build({ name: "x" } as never);
    expect(Constructed).toHaveBeenCalledWith({ name: "x", tenant: A });
  });
});

describe("a tenant the caller names", () => {
  it("is refused in a filter, a document and every kind of update", () => {
    expect(() => db().find({ tenant: A } as never)).toThrow(TenantKeyError);
    expect(() => db().updateOne({}, { $set: { tenant: A } } as never)).toThrow(TenantKeyError);
    expect(() => db().updateOne({}, { $setOnInsert: { tenant: A } } as never)).toThrow(TenantKeyError);
    expect(() => db().updateOne({}, { $unset: { tenant: "" } } as never)).toThrow(TenantKeyError);
    expect(() => db().updateOne({}, { tenant: A } as never)).toThrow(TenantKeyError);
    expect(() => db().updateOne({}, { $rename: { goal: "tenant" } } as never)).toThrow(TenantKeyError);
    expect(() => db().create({ tenant: A } as never)).toThrow(TenantKeyError);
    expect(() => db().insertMany([{ tenant: A }] as never)).toThrow(TenantKeyError);
    expect(() => db().build({ tenant: A } as never)).toThrow(TenantKeyError);
    for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("what cannot be scoped is refused rather than passed through", () => {
  it("an update pipeline, a filter that is not an object, a foreign aggregation stage", () => {
    expect(() => db().updateOne({}, [{ $set: { goal: "x" } }] as never)).toThrow(UnscopableError);
    expect(() => db().find("name" as never)).toThrow(UnscopableError);
    expect(() => db().find([] as never)).toThrow(UnscopableError);
    for (const stage of ["$lookup", "$graphLookup", "$unionWith", "$merge", "$out"]) {
      expect(() => db().aggregate([{ [stage]: {} }] as never)).toThrow(UnscopableError);
    }
    for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("aggregate and bulkWrite", () => {
  it("start the pipeline with the tenant's $match", () => {
    db().aggregate([{ $group: { _id: null } }], { allowDiskUse: true });
    expect(model.aggregate).toHaveBeenCalledWith([{ $match: { tenant: A } }, { $group: { _id: null } }], { allowDiskUse: true });
  });

  it("scope each operation, stamping inserts and replacements", () => {
    db().bulkWrite([
      { insertOne: { document: { name: "n" } } },
      { updateOne: { filter: { name: "u" }, update: { $set: { goal: "g" } } } },
      { deleteMany: { filter: {} } },
      { replaceOne: { filter: { name: "r" }, replacement: { name: "r2" } } },
    ] as never);
    expect(model.bulkWrite).toHaveBeenCalledWith([
      { insertOne: { document: { name: "n", tenant: A } } },
      { updateOne: { filter: { name: "u", tenant: A }, update: { $set: { goal: "g" } } } },
      { deleteMany: { filter: { tenant: A } } },
      { replaceOne: { filter: { name: "r", tenant: A }, replacement: { name: "r2", tenant: A } } },
    ]);
  });

  it("refuse an operation it does not know how to scope", () => {
    expect(() => db().bulkWrite([{ mystery: { filter: {} } }] as never)).toThrow(UnscopableError);
  });

  it("refuse a tenant named inside an operation", () => {
    expect(() => db().bulkWrite([{ updateOne: { filter: { tenant: A }, update: {} } }] as never)).toThrow(TenantKeyError);
    expect(() => db().bulkWrite([{ updateOne: { filter: {}, update: { $set: { tenant: A } } } }] as never)).toThrow(TenantKeyError);
    expect(() => db().bulkWrite([{ insertOne: { document: { tenant: A } } }] as never)).toThrow(TenantKeyError);
  });
});

describe("the tenant a caller works in", () => {
  it("comes from the user, and is the default tenant for a row that carries none", () => {
    expect(tenantOf({ tenant: A }).equals(A)).toBe(true);
    expect(tenantOf({ tenant: A.toHexString() }).equals(A)).toBe(true);
    expect(tenantOf({}).equals(DEFAULT_TENANT_ID)).toBe(true);
    expect(tenantOf({ tenant: null }).equals(DEFAULT_TENANT_ID)).toBe(true);
  });

  it("gives two tenants two accessors, and the same tenant the same one", () => {
    const B = new Types.ObjectId("0000000000000000000000b2");
    scoped(A).Sprint.find({});
    scoped(B).Sprint.find({});
    expect(model.find).toHaveBeenNthCalledWith(1, { tenant: A });
    expect(model.find).toHaveBeenNthCalledWith(2, { tenant: B });
    expect(scoped(A)).toBe(scoped(A.toHexString()));
    expect(scopedFor({ tenant: A })).toBe(scoped(A));
  });

  it("is not an accessor for a model that is not tenant-scoped", () => {
    expect((scoped(A) as unknown as Record<string, unknown>).Tenant).toBeUndefined();
    expect((scoped(A) as unknown as Record<string, unknown>).RateLimit).toBeUndefined();
  });
});
