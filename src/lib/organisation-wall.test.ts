import { describe, it, expect } from "vitest";
import mongoose, { Schema, Types } from "mongoose";
import { withOrganisation } from "./organisation-field";
import { acrossOrganisations, expectOrganisation, OrganisationWallError } from "./organisation-wall";

const ACME = new Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new Types.ObjectId("0000000000000000000000b2");

const offline = mongoose.createConnection();
const Thing = offline.model(
  "WallThing",
  withOrganisation(new Schema({ title: String }, { bufferCommands: false, autoCreate: false, autoIndex: false }))
);

async function verdict(run: () => PromiseLike<unknown>): Promise<"walled" | "passed"> {
  try {
    await run();
    return "passed";
  } catch (error) {
    return error instanceof OrganisationWallError ? "walled" : "passed";
  }
}

describe("organisationWall: a query that names no organisation is refused before it reaches the database", () => {
  const operations: [string, () => PromiseLike<unknown>, () => PromiseLike<unknown>][] = [
    ["find", () => Thing.find({}), () => Thing.find({ organisation: ACME })],
    ["findOne", () => Thing.findOne({}), () => Thing.findOne({ organisation: ACME })],
    ["countDocuments", () => Thing.countDocuments({}), () => Thing.countDocuments({ organisation: ACME })],
    ["distinct", () => Thing.distinct("title"), () => Thing.distinct("title", { organisation: ACME })],
    ["updateOne", () => Thing.updateOne({}, { title: "x" }), () => Thing.updateOne({ organisation: ACME }, { title: "x" })],
    ["updateMany", () => Thing.updateMany({}, { title: "x" }), () => Thing.updateMany({ organisation: ACME }, { title: "x" })],
    ["replaceOne", () => Thing.replaceOne({}, { title: "x" }), () => Thing.replaceOne({ organisation: ACME }, { title: "x", organisation: ACME } as never)],
    ["deleteOne", () => Thing.deleteOne({}), () => Thing.deleteOne({ organisation: ACME })],
    ["deleteMany", () => Thing.deleteMany({}), () => Thing.deleteMany({ organisation: ACME })],
    ["findOneAndUpdate", () => Thing.findOneAndUpdate({}, { title: "x" }), () => Thing.findOneAndUpdate({ organisation: ACME }, { title: "x" })],
    ["findOneAndDelete", () => Thing.findOneAndDelete({}), () => Thing.findOneAndDelete({ organisation: ACME })],
    ["findOneAndReplace", () => Thing.findOneAndReplace({}, { title: "x" }), () => Thing.findOneAndReplace({ organisation: ACME }, { title: "x", organisation: ACME } as never)],
    ["aggregate", () => Thing.aggregate([{ $match: {} }]), () => Thing.aggregate([{ $match: { organisation: ACME } }])],
    ["bulkWrite", () => Thing.bulkWrite([{ deleteMany: { filter: {} } }]), () => Thing.bulkWrite([{ deleteMany: { filter: { organisation: ACME } } }])],
  ];

  for (const [name, unnamed, named] of operations) {
    it(`${name}: refused without one, let through with one`, async () => {
      expect(await verdict(unnamed)).toBe("walled");
      expect(await verdict(named)).toBe("passed");
    });
  }

  it("estimatedDocumentCount names nothing and is refused unless it says why it crosses organisations", async () => {
    expect(await verdict(() => Thing.estimatedDocumentCount())).toBe("walled");
    expect(await verdict(() => acrossOrganisations(Thing.estimatedDocumentCount(), "test"))).toBe("passed");
  });
});

describe("organisationWall: what counts as naming the organisation", () => {
  it("accepts an equality, an $eq and an equality inside a top-level $and", async () => {
    expect(await verdict(() => Thing.find({ organisation: ACME }))).toBe("passed");
    expect(await verdict(() => Thing.find({ organisation: { $eq: ACME } }))).toBe("passed");
    expect(await verdict(() => Thing.find({ $and: [{ title: "x" }, { organisation: ACME }] }))).toBe("passed");
  });

  it("refuses $in, $ne, $exists, null and an equality hidden inside an $or", async () => {
    for (const filter of [
      { organisation: { $in: [ACME, GLOBEX] } },
      { organisation: { $ne: ACME } },
      { organisation: { $exists: true } },
      { organisation: null },
      { $or: [{ organisation: ACME }, { title: "x" }] },
    ]) {
      expect(await verdict(() => Thing.find(filter)), JSON.stringify(filter)).toBe("walled");
    }
  });

  it("refuses a scoped query whose organisation was swapped for another, and lets its own through", async () => {
    expect(await verdict(() => expectOrganisation(Thing.find({ organisation: ACME }), ACME))).toBe("passed");
    expect(await verdict(() => expectOrganisation(Thing.find({ organisation: ACME }), ACME).where("organisation", GLOBEX))).toBe("walled");
    expect(await verdict(() => expectOrganisation(Thing.find({ organisation: ACME }), ACME).merge({ organisation: GLOBEX }))).toBe("walled");
    expect(
      await verdict(() => expectOrganisation(Thing.find({ $and: [{ organisation: ACME }, { organisation: GLOBEX }] }), ACME))
    ).toBe("walled");
  });

  it("refuses an aggregate whose first stage is not the $match on the organisation, or that reaches another collection", async () => {
    expect(await verdict(() => Thing.aggregate([{ $sort: { title: 1 } }, { $match: { organisation: ACME } }]))).toBe("walled");
    const appended = Thing.aggregate([{ $match: { organisation: ACME } }]);
    appended.append({ $unionWith: { coll: "others" } });
    expect(await verdict(() => appended)).toBe("walled");
    const swapped = expectOrganisation(Thing.aggregate([{ $match: { organisation: GLOBEX } }]), ACME);
    expect(await verdict(() => swapped)).toBe("walled");
  });

  it("refuses a bulk insert of a document with no organisation, and an operation it cannot read", async () => {
    expect(await verdict(() => Thing.bulkWrite([{ insertOne: { document: { title: "x" } } }]))).toBe("walled");
    expect(await verdict(() => Thing.bulkWrite([{ insertOne: { document: { title: "x", organisation: ACME } } }]))).toBe("passed");
  });

  it("refuses a write that moves a document to another organisation, however the update is shaped", async () => {
    const named = { organisation: ACME };
    for (const run of [
      () => Thing.updateOne(named, [{ $set: { organisation: GLOBEX } }], { updatePipeline: true }),
      () => Thing.updateOne(named, [{ $unset: "organisation" }], { updatePipeline: true }),
      () => Thing.updateOne(named, [{ $replaceWith: { title: "x" } }], { updatePipeline: true }),
      () => Thing.updateOne(named, { $setOnInsert: { organisation: GLOBEX } }, { upsert: true }),
      () => Thing.updateOne(named, { $set: { organisation: GLOBEX } }, { overwriteImmutable: true }),
      () => Thing.updateOne(named, { $unset: { organisation: 1 } }),
      () => Thing.replaceOne(named, { title: "x", organisation: GLOBEX } as never),
      () => Thing.replaceOne(named, { title: "x" }),
      () => Thing.bulkWrite([{ replaceOne: { filter: named, replacement: { title: "x", organisation: GLOBEX } as never } }]),
      () => Thing.bulkWrite([{ updateOne: { filter: named, update: [{ $set: { organisation: GLOBEX } }] } }]),
    ]) {
      expect(await verdict(run), run.toString()).toBe("walled");
    }
  });

  it("lets a write through that keeps the organisation it named", async () => {
    expect(await verdict(() => Thing.updateOne({ organisation: ACME }, [{ $set: { title: "x" } }], { updatePipeline: true }))).toBe("passed");
    expect(await verdict(() => Thing.updateOne({ organisation: ACME }, { $setOnInsert: { organisation: ACME } }, { upsert: true }))).toBe("passed");
  });

  it("cannot be switched off with Mongoose's middleware option", async () => {
    expect(await verdict(() => Thing.find({}, null, { middleware: false }))).toBe("walled");
    expect(await verdict(() => Thing.updateMany({}, { title: "x" }, { middleware: { pre: false } }))).toBe("walled");
    expect(await verdict(() => Thing.aggregate([{ $match: {} }]).option({ middleware: false } as never))).toBe("walled");
    expect(await verdict(() => Thing.bulkWrite([{ deleteMany: { filter: {} } }], { middleware: false } as never))).toBe("walled");
  });

  it("an escape needs a reason", () => {
    expect(() => acrossOrganisations(Thing.find({}), "  ")).toThrow(/says why/);
  });

  it("sets the organisation as the shard key, so a document's own save, update and delete name it", () => {
    expect(Thing.schema.get("shardKey")).toEqual({ organisation: 1 });
  });
});
