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

const { scoped, scopedFor, organisationOf, OrganisationKeyError, UnscopableError } = await import("./db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("./organisation-field");

const A = new Types.ObjectId("0000000000000000000000a1");
const db = () => scoped(A).Sprint;

beforeEach(() => {
  for (const fn of Object.values(model)) fn.mockReset();
  Constructed.mockReset();
});

describe("reads", () => {
  it("add the organisation to a filter and keep the rest of the call", () => {
    db().find({ name: "x" }, "name", { lean: true });
    expect(model.find).toHaveBeenCalledWith({ name: "x", organisation: A }, "name", { lean: true });
  });

  it("scope a call that names no filter at all", () => {
    db().find();
    db().countDocuments();
    db().exists(undefined as never);
    expect(model.find).toHaveBeenCalledWith({ organisation: A });
    expect(model.countDocuments).toHaveBeenCalledWith({ organisation: A });
    expect(model.exists).toHaveBeenCalledWith({ organisation: A });
  });

  it("turn findById into an organisation-scoped findOne, and an absent id into a miss", () => {
    const id = new Types.ObjectId();
    db().findById(id, "name");
    db().findById(undefined);
    expect(model.findOne).toHaveBeenNthCalledWith(1, { _id: id, organisation: A }, "name");
    expect(model.findOne).toHaveBeenNthCalledWith(2, { _id: null, organisation: A });
  });

  it("keep a top-level $or inside the organisation", () => {
    db().find({ $or: [{ name: "a" }, { name: "b" }] });
    expect(model.find).toHaveBeenCalledWith({ $or: [{ name: "a" }, { name: "b" }], organisation: A });
  });

  it("scope distinct's filter and leave its field alone", () => {
    db().distinct("name", { goal: "g" });
    expect(model.distinct).toHaveBeenCalledWith("name", { goal: "g", organisation: A });
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

    expect(model.updateOne).toHaveBeenCalledWith({ name: "x", organisation: A }, { $set: { goal: "g" } }, { upsert: true });
    expect(model.updateMany).toHaveBeenCalledWith({ organisation: A }, { $set: { goal: "g" } });
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(1, { name: "x", organisation: A }, { $set: { goal: "g" } }, { new: true });
    expect(model.findOneAndUpdate).toHaveBeenNthCalledWith(2, { _id: id, organisation: A }, { $set: { goal: "g" } });
    expect(model.deleteOne).toHaveBeenCalledWith({ name: "x", organisation: A });
    expect(model.deleteMany).toHaveBeenCalledWith({ organisation: A });
    expect(model.findOneAndDelete).toHaveBeenNthCalledWith(1, { name: "x", organisation: A });
    expect(model.findOneAndDelete).toHaveBeenNthCalledWith(2, { _id: id, organisation: A });
  });

  it("stamp the organisation on what create and insertMany write", () => {
    db().create({ name: "x" } as never);
    db().create([{ name: "y" }, { name: "z" }] as never);
    db().insertMany([{ name: "w" }] as never);
    expect(model.create).toHaveBeenNthCalledWith(1, { name: "x", organisation: A });
    expect(model.create).toHaveBeenNthCalledWith(2, [
      { name: "y", organisation: A },
      { name: "z", organisation: A },
    ]);
    expect(model.insertMany).toHaveBeenCalledWith([{ name: "w", organisation: A }]);
  });

  it("create stamps every document it is given, however it is called", () => {
    db().create({ name: "x" } as never, { name: "y" } as never);
    expect(model.create).toHaveBeenCalledWith({ name: "x", organisation: A }, { name: "y", organisation: A });
    expect(() => db().create({ name: "x" } as never, { organisation: Types.ObjectId.createFromHexString("0000000000000000000000b2") } as never)).toThrow(OrganisationKeyError);
  });

  it("create drops an absent trailing options argument, as Mongoose does", () => {
    db().create({ name: "x" } as never, undefined as never);
    db().create([{ name: "y" }] as never, null as never);
    expect(model.create).toHaveBeenNthCalledWith(1, { name: "x", organisation: A });
    expect(model.create).toHaveBeenNthCalledWith(2, [{ name: "y", organisation: A }]);
  });

  it("create keeps the options of the array form", () => {
    db().create([{ name: "x" }] as never, { ordered: true } as never);
    expect(model.create).toHaveBeenCalledWith([{ name: "x", organisation: A }], { ordered: true });
  });

  it("build constructs the model with the organisation set", () => {
    db().build({ name: "x" } as never);
    expect(Constructed).toHaveBeenCalledWith({ name: "x", organisation: A });
  });
});

describe("an organisation the caller names", () => {
  it("is refused by every update form, not only updateOne", () => {
    expect(() => db().updateMany({}, { $set: { organisation: A } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().findOneAndUpdate({}, { $set: { organisation: A } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().findByIdAndUpdate(new Types.ObjectId(), { $set: { organisation: A } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().findOneAndUpdate({}, [{ $set: { goal: "x" } }] as never)).toThrow(UnscopableError);
    expect(() => db().updateMany({}, [{ $set: { goal: "x" } }] as never)).toThrow(UnscopableError);
  });

  it("is refused in a filter, a document and every kind of update", () => {
    expect(() => db().find({ organisation: A } as never)).toThrow(OrganisationKeyError);
    expect(() => db().updateOne({}, { $set: { organisation: A } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().updateOne({}, { $setOnInsert: { organisation: A } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().updateOne({}, { $unset: { organisation: "" } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().updateOne({}, { organisation: A } as never)).toThrow(OrganisationKeyError);
    expect(() => db().updateOne({}, { $rename: { goal: "organisation" } } as never)).toThrow(OrganisationKeyError);
    expect(() => db().create({ organisation: A } as never)).toThrow(OrganisationKeyError);
    expect(() => db().insertMany([{ organisation: A }] as never)).toThrow(OrganisationKeyError);
    expect(() => db().build({ organisation: A } as never)).toThrow(OrganisationKeyError);
    for (const fn of Object.values(model)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("what cannot be scoped is refused rather than passed through", () => {
  it("a foreign stage nested in $facet or a sub-pipeline", () => {
    expect(() => db().aggregate([{ $facet: { x: [{ $lookup: { from: "sprints", pipeline: [], as: "all" } }] } }] as never)).toThrow(UnscopableError);
    expect(() => db().aggregate([{ $group: { _id: null } }, { $facet: { x: [{ $unionWith: "sprints" }] } }] as never)).toThrow(UnscopableError);
  });

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
  it("start the pipeline with the organisation's $match", () => {
    db().aggregate([{ $group: { _id: null } }], { allowDiskUse: true });
    expect(model.aggregate).toHaveBeenCalledWith([{ $match: { organisation: A } }, { $group: { _id: null } }], { allowDiskUse: true });
  });

  it("scope each operation, stamping inserts and replacements", () => {
    db().bulkWrite([
      { insertOne: { document: { name: "n" } } },
      { updateOne: { filter: { name: "u" }, update: { $set: { goal: "g" } } } },
      { deleteMany: { filter: {} } },
      { replaceOne: { filter: { name: "r" }, replacement: { name: "r2" } } },
    ] as never);
    expect(model.bulkWrite).toHaveBeenCalledWith([
      { insertOne: { document: { name: "n", organisation: A } } },
      { updateOne: { filter: { name: "u", organisation: A }, update: { $set: { goal: "g" } } } },
      { deleteMany: { filter: { organisation: A } } },
      { replaceOne: { filter: { name: "r", organisation: A }, replacement: { name: "r2", organisation: A } } },
    ]);
  });

  it("refuse an operation it does not know how to scope", () => {
    expect(() => db().bulkWrite([{ mystery: { filter: {} } }] as never)).toThrow(UnscopableError);
  });

  it("refuse an organisation named inside an operation", () => {
    expect(() => db().bulkWrite([{ updateOne: { filter: { organisation: A }, update: {} } }] as never)).toThrow(OrganisationKeyError);
    expect(() => db().bulkWrite([{ updateOne: { filter: {}, update: { $set: { organisation: A } } } }] as never)).toThrow(OrganisationKeyError);
    expect(() => db().bulkWrite([{ insertOne: { document: { organisation: A } } }] as never)).toThrow(OrganisationKeyError);
  });
});

describe("the organisation a caller works in", () => {
  it("comes from the user, and is the default organisation for a row that carries none", () => {
    expect(organisationOf({ organisation: A }).equals(A)).toBe(true);
    expect(organisationOf({ organisation: A.toHexString() }).equals(A)).toBe(true);
    expect(organisationOf({}).equals(DEFAULT_ORGANISATION_ID)).toBe(true);
    expect(organisationOf({ organisation: null }).equals(DEFAULT_ORGANISATION_ID)).toBe(true);
  });

  it("gives two organisations two accessors, and the same organisation the same one", () => {
    const B = new Types.ObjectId("0000000000000000000000b2");
    scoped(A).Sprint.find({});
    scoped(B).Sprint.find({});
    expect(model.find).toHaveBeenNthCalledWith(1, { organisation: A });
    expect(model.find).toHaveBeenNthCalledWith(2, { organisation: B });
    expect(scoped(A)).toBe(scoped(A.toHexString()));
    expect(scopedFor({ organisation: A })).toBe(scoped(A));
  });

  it("says which organisation it is, so two organisations' accessors are never equal", () => {
    const B = new Types.ObjectId("0000000000000000000000b2");
    expect(scoped(A).organisation.equals(A)).toBe(true);
    expect(scoped(A)).not.toEqual(scoped(B));
    expect(scoped(A)).not.toEqual({});
    expect(scoped(A)).toEqual(scoped(A.toHexString()));
  });

  it("is not an accessor for a model that is not organisation-scoped", () => {
    expect((scoped(A) as unknown as Record<string, unknown>).Organisation).toBeUndefined();
    expect((scoped(A) as unknown as Record<string, unknown>).RateLimit).toBeUndefined();
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect((scoped(A) as unknown as Record<string, unknown>)[inherited]).toBeUndefined();
    }
  });
});
