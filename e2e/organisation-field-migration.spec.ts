import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { copyLegacyField, finaliseLegacyField, LEGACY_COLLECTION, LEGACY_FIELD } from "../src/lib/organisation-field-migration";
import { scopedModelNames } from "../src/lib/organisation-migration";
import { scoped } from "../src/lib/db-scope";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_orgfield_e2e`;
const ORG = new mongoose.Types.ObjectId("000000000000000000000001");
const OTHER = new mongoose.Types.ObjectId("0000000000000000000000aa");
const ORG_ROW = { _id: ORG, name: "Rafał-org", slug: "rafal-org", entitlements: { plan: "pro", features: ["integrations.coda"], source: "service" } };

const col = (name: string) => mongoose.connection.db!.collection(name);
const collectionOf = (model: string) => mongoose.model(model).collection.name;
const scopedCollections = () => scopedModelNames().map(collectionOf);

test.beforeEach(async () => {
  await mongoose.connect(E2E_MONGODB_URI, { dbName: DB, autoIndex: false, autoCreate: false });
  await mongoose.connection.dropDatabase();
  await col("users").createIndex({ username: 1, [LEGACY_FIELD]: 1 }, { unique: true, name: `username_1_${LEGACY_FIELD}_1` });
  await col("projects").createIndex({ key: 1, [LEGACY_FIELD]: 1 }, { unique: true, name: `key_1_${LEGACY_FIELD}_1` });
  await col("projects").createIndex({ archived: 1 }, { name: "archived_1" });
  for (const name of scopedCollections()) {
    await col(name).insertOne({ [LEGACY_FIELD]: ORG, username: `u-${name}`, key: name.toUpperCase(), legacy: name });
  }
  await col("users").insertOne({ [LEGACY_FIELD]: OTHER, username: "boss", email: "boss@other.test", kind: "human", role: "admin" });
  await col(LEGACY_COLLECTION).insertMany([ORG_ROW, { _id: OTHER, name: "Other", slug: "other" }]);
});

test.afterEach(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("a dry run counts every document and organisation it would copy, and writes nothing", async () => {
  const report = await copyLegacyField(mongoose.connection, { apply: false });

  expect(report.byCollection.users).toBe(2);
  expect(report.total).toBe(scopedCollections().length + 1);
  expect(report.organisationRows).toBe(2);
  expect(await col("users").countDocuments({ organisation: { $exists: true } })).toBe(0);
  expect(await col("organisations").countDocuments()).toBe(0);
});

test("the copy gives every document its organisation and every organisation its row, and a second run finds nothing", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });

  for (const name of scopedCollections()) {
    const rows = await col(name).find({}).toArray();
    for (const row of rows) expect(String(row.organisation), name).toBe(String(row[LEGACY_FIELD]));
  }
  expect(await col("organisations").findOne({ _id: ORG })).toEqual(ORG_ROW);
  expect(await col("organisations").countDocuments()).toBe(2);

  const again = await copyLegacyField(mongoose.connection, { apply: true });
  expect([again.total, again.organisationRows]).toEqual([0, 0]);
});

test("the copy never overwrites a document's organisation already there", async () => {
  await col("tasks").insertOne({ [LEGACY_FIELD]: ORG, organisation: OTHER, title: "already moved" });

  await copyLegacyField(mongoose.connection, { apply: true });

  expect(String((await col("tasks").findOne({ title: "already moved" }))!.organisation)).toBe(String(OTHER));
});

test("an organisation row the new release made first is reported, kept, and blocks finalising until the old row wins", async () => {
  await col("organisations").insertOne({ _id: ORG, entitlements: { plan: "free", features: [] } });

  const report = await copyLegacyField(mongoose.connection, { apply: true });

  expect(report.differing).toEqual([{ _id: String(ORG), fields: ["name", "slug", "entitlements"] }]);
  expect((await col("organisations").findOne({ _id: ORG }))!.entitlements.plan).toBe("free");
  await expect(finaliseLegacyField(mongoose.connection, { apply: true })).rejects.toThrow(/differs from its old row in name, slug, entitlements/);
  expect((await mongoose.connection.db!.listCollections({ name: LEGACY_COLLECTION }).toArray()).length).toBe(1);

  const won = await copyLegacyField(mongoose.connection, { apply: true, legacyWins: true });
  expect(won.differing.map((row) => row._id)).toEqual([String(ORG)]);
  expect(await col("organisations").findOne({ _id: ORG })).toEqual(ORG_ROW);
  expect((await copyLegacyField(mongoose.connection, { apply: true })).differing).toEqual([]);
  await finaliseLegacyField(mongoose.connection, { apply: true });
  expect(await col("organisations").findOne({ _id: ORG })).toEqual(ORG_ROW);
});

test("a rename made on the old row after the copy blocks finalising rather than vanishing with it", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });
  await col(LEGACY_COLLECTION).updateOne({ _id: ORG }, { $set: { name: "Renamed in the window" } });

  await expect(finaliseLegacyField(mongoose.connection, { apply: true })).rejects.toThrow(/differs from its old row in name/);
});

test("a dry run with the old row winning writes nothing", async () => {
  await col("organisations").insertOne({ _id: ORG, name: "Other name" });

  const report = await copyLegacyField(mongoose.connection, { apply: false, legacyWins: true });

  expect(report.differing[0].fields).toContain("name");
  expect((await col("organisations").findOne({ _id: ORG }))!.name).toBe("Other name");
});

test("the app reads what the copy moved, scoped to each organisation", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });

  expect(await scoped(OTHER).User.findOne({ username: "boss" }).lean()).toMatchObject({ email: "boss@other.test" });
  expect(await scoped(ORG).User.findOne({ username: "boss" }).lean()).toBeNull();
});

test("finalising refuses while a document carries only the old field, and changes nothing", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });
  await col("comments").insertOne({ [LEGACY_FIELD]: ORG, body: "written by the old release after the copy" });

  await expect(finaliseLegacyField(mongoose.connection, { apply: true })).rejects.toThrow(/run the copy again/);

  expect(await col("users").countDocuments({ [LEGACY_FIELD]: { $exists: true } })).toBe(2);
  expect((await col("users").indexes()).map((index) => index.name)).toContain(`username_1_${LEGACY_FIELD}_1`);
  expect((await mongoose.connection.db!.listCollections({ name: LEGACY_COLLECTION }).toArray()).length).toBe(1);
});

test("finalising refuses while an organisation row is not copied", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });
  await col(LEGACY_COLLECTION).insertOne({ _id: new mongoose.Types.ObjectId("0000000000000000000000bb"), name: "Late" });

  await expect(finaliseLegacyField(mongoose.connection, { apply: true })).rejects.toThrow(/has not been copied/);
  expect((await mongoose.connection.db!.listCollections({ name: LEGACY_COLLECTION }).toArray()).length).toBe(1);
});

test("finalising drops the old field, its indexes and the old collection, and keeps everything else", async () => {
  await copyLegacyField(mongoose.connection, { apply: true });

  const dry = await finaliseLegacyField(mongoose.connection, { apply: false });
  expect(dry.droppedIndexes.sort()).toEqual([`projects.key_1_${LEGACY_FIELD}_1`, `users.username_1_${LEGACY_FIELD}_1`]);
  expect(await col("users").countDocuments({ [LEGACY_FIELD]: { $exists: true } })).toBe(2);

  const done = await finaliseLegacyField(mongoose.connection, { apply: true });

  expect(done.total).toBe(scopedCollections().length + 1);
  for (const name of scopedCollections()) {
    expect(await col(name).countDocuments({ [LEGACY_FIELD]: { $exists: true } }), name).toBe(0);
    expect(await col(name).countDocuments({ organisation: { $exists: false } }), name).toBe(0);
  }
  expect((await col("users").indexes()).map((index) => index.name)).toEqual(["_id_"]);
  expect((await col("projects").indexes()).map((index) => index.name).sort()).toEqual(["_id_", "archived_1"]);
  expect((await mongoose.connection.db!.listCollections({ name: LEGACY_COLLECTION }).toArray()).length).toBe(0);
  expect(await col("organisations").countDocuments()).toBe(2);
  expect(await scoped(OTHER).User.findOne({ username: "boss" }).lean()).toMatchObject({ email: "boss@other.test" });

  const again = await finaliseLegacyField(mongoose.connection, { apply: true });
  expect([again.total, again.droppedIndexes.length, again.droppedCollection]).toEqual([0, 0, false]);
});
