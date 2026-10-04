import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { SCOPED_MODELS, scoped, TenantKeyError, UnscopableError } from "../src/lib/db-scope";
import { scopedModelNames } from "../src/lib/tenant-migration";
import { Sprint } from "../src/models/sprint";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_dbscope_e2e`;
const A = new mongoose.Types.ObjectId("0000000000000000000000a1");
const B = new mongoose.Types.ObjectId("0000000000000000000000b2");
const PROJECT = new mongoose.Types.ObjectId("0000000000000000000000c3");

const sprint = (name: string) => ({
  project: PROJECT,
  name,
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-01-14"),
});

const rawRows = () => mongoose.connection.db!.collection("sprints").find({}).sort({ name: 1 }).toArray();
const names = (rows: object[]) => rows.map((row) => String((row as { name: unknown }).name)).sort();

async function dropOwnDatabase() {
  expect(mongoose.connection.db?.databaseName).toBe(DB);
  await mongoose.connection.dropDatabase();
}

test.beforeAll(async () => {
  await mongoose.disconnect();
  await mongoose.connect(E2E_MONGODB_URI, { dbName: DB, autoIndex: false, autoCreate: false });
});

test.afterAll(async () => {
  await dropOwnDatabase();
  await mongoose.disconnect();
});

test.beforeEach(async () => {
  await dropOwnDatabase();
  await scoped(A).Sprint.create(sprint("a-one"));
  await scoped(A).Sprint.create(sprint("a-two"));
  await scoped(B).Sprint.create(sprint("b-one"));
});

test("the accessor covers exactly the models that carry a tenant", () => {
  expect(Object.values(SCOPED_MODELS).map((model) => model().modelName).sort()).toEqual([...scopedModelNames()].sort());
});

test("create and insertMany stamp the caller's tenant, never the schema default", async () => {
  const rows = await rawRows();
  expect(rows.filter((row) => A.equals(row.tenant))).toHaveLength(2);
  expect(rows.filter((row) => B.equals(row.tenant))).toHaveLength(1);

  await scoped(B).Sprint.insertMany([sprint("b-two"), sprint("b-three")]);
  const second = (await rawRows()).filter((row) => String(row.name).startsWith("b-"));
  expect(second).toHaveLength(3);
  expect(second.every((row) => B.equals(row.tenant))).toBe(true);
});

test("create with several documents stamps every one, none falls back to the schema default", async () => {
  await scoped(B).Sprint.create(sprint("b-x") as never, sprint("b-y") as never, sprint("b-z") as never);

  const rows = (await rawRows()).filter((row) => /^b-[xyz]$/.test(String(row.name)));
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => B.equals(row.tenant))).toBe(true);
});

test("reads see only the caller's tenant", async () => {
  expect(names(await scoped(A).Sprint.find({}))).toEqual(["a-one", "a-two"]);
  expect(names(await scoped(B).Sprint.find({}))).toEqual(["b-one"]);
  expect(names(await scoped(A).Sprint.find())).toEqual(["a-one", "a-two"]);
  expect(await scoped(A).Sprint.findOne({ name: "b-one" })).toBeNull();
  expect(await scoped(B).Sprint.findOne({ name: "b-one" })).not.toBeNull();
  expect(await scoped(A).Sprint.countDocuments({})).toBe(2);
  expect(await scoped(A).Sprint.countDocuments()).toBe(2);
  expect(await scoped(A).Sprint.exists({ name: "b-one" })).toBeNull();
  expect(await scoped(B).Sprint.exists({ name: "b-one" })).not.toBeNull();
  expect((await scoped(A).Sprint.distinct("name")).sort()).toEqual(["a-one", "a-two"]);
});

test("a row of another tenant cannot be fetched by its id", async () => {
  const [b] = await scoped(B).Sprint.find({});
  expect(await scoped(A).Sprint.findById(b._id)).toBeNull();
  expect(await scoped(B).Sprint.findById(b._id)).not.toBeNull();
  expect(await scoped(A).Sprint.findById(undefined)).toBeNull();
});

test("a $or in a filter cannot reach past the tenant", async () => {
  const found = await scoped(A).Sprint.find({ $or: [{ name: "b-one" }, { name: "a-one" }] });
  expect(names(found)).toEqual(["a-one"]);
});

test("writes by another tenant change nothing", async () => {
  const [b] = await scoped(B).Sprint.find({});

  expect((await scoped(A).Sprint.updateOne({ _id: b._id }, { $set: { goal: "taken" } })).matchedCount).toBe(0);
  expect((await scoped(A).Sprint.updateMany({}, { $set: { goal: "all" } })).matchedCount).toBe(2);
  expect(await scoped(A).Sprint.findOneAndUpdate({ _id: b._id }, { $set: { goal: "taken" } })).toBeNull();
  expect(await scoped(A).Sprint.findByIdAndUpdate(b._id, { $set: { goal: "taken" } })).toBeNull();
  expect((await scoped(A).Sprint.deleteOne({ _id: b._id })).deletedCount).toBe(0);
  expect(await scoped(A).Sprint.findOneAndDelete({ _id: b._id })).toBeNull();
  expect(await scoped(A).Sprint.findByIdAndDelete(b._id)).toBeNull();

  const stillThere = await scoped(B).Sprint.findOne({ name: "b-one" });
  expect(stillThere?.goal).toBe("");
});

test("deleteMany with no filter deletes the caller's tenant and nobody else's", async () => {
  expect((await scoped(A).Sprint.deleteMany({})).deletedCount).toBe(2);
  expect(names(await rawRows())).toEqual(["b-one"]);
  expect((await scoped(B).Sprint.deleteMany()).deletedCount).toBe(1);
  expect(await rawRows()).toHaveLength(0);
});

test("an upsert creates the row in the caller's tenant, not the schema default", async () => {
  await scoped(A).Sprint.updateOne({ name: "fresh" }, { $set: { ...sprint("fresh") } }, { upsert: true });
  await scoped(B).Sprint.findOneAndUpdate({ name: "fresh-b" }, { $set: sprint("fresh-b") }, { upsert: true });

  const rows = await rawRows();
  expect(A.equals(rows.find((row) => row.name === "fresh")?.tenant)).toBe(true);
  expect(B.equals(rows.find((row) => row.name === "fresh-b")?.tenant)).toBe(true);
});

test("an upsert in one tenant does not touch the same key in another", async () => {
  await scoped(B).Sprint.updateOne({ name: "a-one" }, { $set: { goal: "b's own", ...sprint("a-one") } }, { upsert: true });

  const rows = (await rawRows()).filter((row) => row.name === "a-one");
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => A.equals(row.tenant))?.goal).toBe("");
  expect(rows.find((row) => B.equals(row.tenant))?.goal).toBe("b's own");
});

test("a tenant named in a filter, a document or an update is refused, not honoured", async () => {
  expect(() => scoped(A).Sprint.find({ tenant: B })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.findOne({ tenant: B })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.deleteMany({ tenant: B })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.updateOne({}, { $set: { tenant: B } })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.updateOne({}, { $setOnInsert: { tenant: B } })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.updateOne({}, { tenant: B })).toThrow(TenantKeyError);
  expect(() => scoped(A).Sprint.updateOne({}, { $rename: { goal: "tenant" } })).toThrow(TenantKeyError);
  await expect(async () => scoped(A).Sprint.create({ ...sprint("x"), tenant: B } as never)).rejects.toThrow(TenantKeyError);
  await expect(async () => scoped(A).Sprint.insertMany([{ ...sprint("x"), tenant: B }] as never)).rejects.toThrow(TenantKeyError);
  expect(await scoped(B).Sprint.countDocuments({})).toBe(1);
});

test("an update pipeline and a filter that is not an object cannot be scoped", () => {
  expect(() => scoped(A).Sprint.updateOne({}, [{ $set: { goal: "x" } }] as never)).toThrow(UnscopableError);
  expect(() => scoped(A).Sprint.find("a-one" as never)).toThrow(UnscopableError);
});

test("aggregate is scoped by a leading $match, and a stage that reads other collections is refused", async () => {
  const counted = await scoped(A).Sprint.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
  expect(counted).toEqual([{ _id: null, n: 2 }]);
  for (const stage of [{ $lookup: { from: "sprints", localField: "project", foreignField: "project", as: "x" } }, { $unionWith: "sprints" }, { $out: "elsewhere" }]) {
    expect(() => scoped(A).Sprint.aggregate([stage])).toThrow(UnscopableError);
  }
});

test("bulkWrite scopes every operation it carries", async () => {
  const [b] = await scoped(B).Sprint.find({});
  await scoped(A).Sprint.bulkWrite([
    { insertOne: { document: sprint("a-bulk") as never } },
    { updateOne: { filter: { _id: b._id }, update: { $set: { goal: "taken" } } } },
    { deleteMany: { filter: { name: "b-one" } } },
  ] as never);

  const rows = await rawRows();
  expect(A.equals(rows.find((row) => row.name === "a-bulk")?.tenant)).toBe(true);
  const untouched = rows.find((row) => row.name === "b-one");
  expect(untouched?.goal).toBe("");
});

test("build gives a document that saves into the caller's tenant", async () => {
  const doc = scoped(B).Sprint.build(sprint("built"));
  await doc.save();

  expect(B.equals((await rawRows()).find((row) => row.name === "built")?.tenant)).toBe(true);
});

test("the schema default is not what scopes a scoped write: the default tenant is just another tenant", async () => {
  const defaultTenant = new mongoose.Types.ObjectId("000000000000000000000001");
  await scoped(defaultTenant).Sprint.create(sprint("default-one"));

  expect(names(await scoped(A).Sprint.find({}))).toEqual(["a-one", "a-two"]);
  expect(names(await scoped(defaultTenant).Sprint.find({}))).toEqual(["default-one"]);
  expect(await Sprint.countDocuments({})).toBe(4);
});
