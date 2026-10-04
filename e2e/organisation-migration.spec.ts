import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { backfillOrganisations, dropGlobalUniques, ensureOrganisation, RETIRED_GLOBAL_UNIQUES, scopedModelNames } from "../src/lib/organisation-migration";
import { DEFAULT_ORGANISATION_ID } from "../src/lib/organisation-field";
import { duplicateKeyField } from "../src/lib/mongo-errors";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const LEGACY_DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_organisationmig_e2e`;
const OTHER_ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000aa");
const THIRD_ORGANISATION = new mongoose.Types.ObjectId("0000000000000000000000bb");
const LEGACY_ORGANISATION_ROW = { _id: new mongoose.Types.ObjectId("0000000000000000000000cc"), entitlements: { plan: "pro", features: [], source: "service" } };

const LEGACY_INDEXES: Record<string, { key: Record<string, 1>; name: string; partial?: object }[]> = {
  users: [
    { key: { username: 1 }, name: "username_1" },
    { key: { email: 1 }, name: "email_1", partial: { email: { $gt: "" } } },
  ],
  projects: [{ key: { key: 1 }, name: "key_1" }],
  workers: [{ key: { name: 1, host: 1 }, name: "name_1_host_1" }],
  identities: [{ key: { issuer: 1, subject: 1 }, name: "issuer_1_subject_1" }],
  invitations: [{ key: { email: 1 }, name: "email_1", partial: { status: "pending" } }],
  agentblocks: [{ key: { key: 1 }, name: "key_1" }],
};

let conn: mongoose.Connection;
const col = (name: string) => conn.db!.collection(name);
const collectionOf = (model: string) => mongoose.model(model).collection.name;
const scopedCollections = () => scopedModelNames().map(collectionOf);
const expectedIn = (collection: string) => ({ users: 3, invitations: 3 })[collection as "users"] ?? 1;

test.beforeEach(async () => {
  conn = mongoose.createConnection(E2E_MONGODB_URI, { dbName: LEGACY_DB, autoIndex: false, autoCreate: false });
  await conn.asPromise();
  await conn.dropDatabase();
  for (const [collection, indexes] of Object.entries(LEGACY_INDEXES)) {
    for (const { key, name, partial } of indexes) {
      await col(collection).createIndex(key, {
        unique: true,
        name,
        ...(partial ? { partialFilterExpression: partial } : {}),
      });
    }
  }
  for (const name of [...scopedCollections(), collectionOf("RateLimit")]) {
    await col(name).insertOne({ legacy: name, username: `u-${name}`, email: `${name}@x.test`, key: name.toUpperCase(), tokenHash: `hash-${name}` });
  }
  await col("users").insertMany([
    { username: "blank-a", email: "" },
    { username: "blank-b", email: "" },
  ]);
  await col("invitations").insertMany([
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-1" },
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-2" },
  ]);
  await col(collectionOf("Organisation")).insertOne(LEGACY_ORGANISATION_ROW);
});

test.afterEach(async () => {
  await conn?.dropDatabase();
  await conn?.close();
});

async function wholeDatabase() {
  const everything: Record<string, unknown> = {};
  for (const { name } of await conn.db!.listCollections().toArray()) {
    everything[name] = {
      documents: await col(name).find({}).sort({ _id: 1 }).toArray(),
      indexes: (await col(name).indexes()).map((i) => i.name).sort(),
    };
  }
  return JSON.stringify(everything);
}

test("a dry run says what it would give and writes nothing", async () => {
  const before = await wholeDatabase();

  const { total, byCollection } = await backfillOrganisations(conn, { apply: false });

  for (const name of scopedCollections()) expect(byCollection[name], name).toBe(expectedIn(name));
  expect(total).toBe(scopedCollections().reduce((sum, name) => sum + expectedIn(name), 0));
  expect(await wholeDatabase()).toBe(before);
});

test("apply gives every scoped document the default organisation and touches nothing else", async () => {
  const throttleAndOrganisations = async () =>
    JSON.stringify([await col(collectionOf("RateLimit")).find({}).toArray(), await col(collectionOf("Organisation")).find({}).toArray()]);
  const untouchedBefore = await throttleAndOrganisations();
  const indexesBefore = await col("users").indexes();

  await backfillOrganisations(conn, { apply: true });

  for (const name of scopedCollections()) {
    expect(await col(name).countDocuments({ organisation: DEFAULT_ORGANISATION_ID }), name).toBe(expectedIn(name));
    expect(await col(name).countDocuments({ organisation: null }), name).toBe(0);
  }
  expect(await throttleAndOrganisations()).toBe(untouchedBefore);
  expect(await col("users").indexes()).toEqual(indexesBefore);
});

test("a second run gives nothing", async () => {
  await backfillOrganisations(conn, { apply: true });

  const { total } = await backfillOrganisations(conn, { apply: true });

  expect(total).toBe(0);
});

test("a late row, with the field missing or null, is given the default organisation and another organisation's row is left alone", async () => {
  await backfillOrganisations(conn, { apply: true });
  await col("projects").insertMany([{ key: "OTHER", organisation: OTHER_ORGANISATION }, { key: "MISSING" }, { key: "NULLED", organisation: null }]);

  const { total } = await backfillOrganisations(conn, { apply: true });

  expect(total).toBe(2);
  expect(await col("projects").findOne({ key: "OTHER" })).toMatchObject({ organisation: OTHER_ORGANISATION });
  expect(await col("projects").findOne({ key: "MISSING" })).toMatchObject({ organisation: DEFAULT_ORGANISATION_ID });
  expect(await col("projects").findOne({ key: "NULLED" })).toMatchObject({ organisation: DEFAULT_ORGANISATION_ID });
});

const organisationRows = () => col(collectionOf("Organisation")).find({}).toArray();

test("a legacy organisation row becomes the named organisation, keeping its entitlements, and nothing is written in a dry run", async () => {
  const before = await wholeDatabase();

  expect(await ensureOrganisation(conn, { apply: false, name: "Rafał-org" })).toBe("re-keyed");
  expect(await wholeDatabase()).toBe(before);

  expect(await ensureOrganisation(conn, { apply: true, name: "Rafał-org" })).toBe("re-keyed");
  const rows = await organisationRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ _id: DEFAULT_ORGANISATION_ID, name: "Rafał-org", entitlements: LEGACY_ORGANISATION_ROW.entitlements });
});

test("an instance with no organisation row gets one, named", async () => {
  await col(collectionOf("Organisation")).deleteMany({});

  expect(await ensureOrganisation(conn, { apply: true, name: "Acme" })).toBe("created");

  expect(await organisationRows()).toMatchObject([{ _id: DEFAULT_ORGANISATION_ID, name: "Acme", entitlements: { plan: "free", source: "none" } }]);
});

test("naming an organisation again renames it and a second run changes nothing else", async () => {
  await ensureOrganisation(conn, { apply: true, name: "First" });

  expect(await ensureOrganisation(conn, { apply: true, name: "Second" })).toBe("present");

  expect(await organisationRows()).toMatchObject([{ _id: DEFAULT_ORGANISATION_ID, name: "Second", entitlements: LEGACY_ORGANISATION_ROW.entitlements }]);
});

test("two organisation rows and none on the default id are refused rather than guessed at", async () => {
  await col(collectionOf("Organisation")).insertOne({ _id: new mongoose.Types.ObjectId(), entitlements: {} });

  await expect(ensureOrganisation(conn, { apply: true, name: "X" })).rejects.toThrow(/cannot tell which is the organisation/);
});

type Spec = { model: string; fields: Record<string, number>; options: { partialFilterExpression?: Record<string, unknown> } };

const declaredPerOrganisationUniques: Spec[] = scopedModelNames().flatMap((model) =>
  mongoose
    .model(model)
    .schema.indexes()
    .filter(([fields, options]) => options?.unique && "organisation" in fields && Object.keys(fields).length > 1)
    .map(([fields, options]) => ({ model, fields: fields as Record<string, number>, options: options as Spec["options"] }))
);

test("the per-organisation uniques build beside the old ones on data that has blank e-mails and answered invitations", async () => {
  await backfillOrganisations(conn, { apply: true });

  for (const model of new Set(declaredPerOrganisationUniques.map((u) => u.model))) {
    await (conn.model(model, mongoose.model(model).schema) as mongoose.Model<mongoose.AnyObject>).createIndexes();
  }

  for (const { model, fields } of declaredPerOrganisationUniques) {
    const names = (await col(collectionOf(model)).indexes()).map((i) => i.name);
    expect(names, model).toContain(Object.entries(fields).map(([k, v]) => `${k}_${v}`).join("_"));
    expect(names.length, `${model} keeps its global twin`).toBeGreaterThan(2);
  }
});

async function buildPerOrganisationTwins() {
  await backfillOrganisations(conn, { apply: true });
  for (const model of new Set(declaredPerOrganisationUniques.map((u) => u.model))) {
    await (conn.model(model, mongoose.model(model).schema) as mongoose.Model<mongoose.AnyObject>).createIndexes();
  }
}

const indexNames = async (collection: string) => (await col(collection).indexes()).map((i) => i.name);

test("BP-665: the global uniques are dropped only where the per-organisation twin already exists", async () => {
  await expect(dropGlobalUniques(conn, { apply: true })).rejects.toThrow(/twin .* is not built yet/);
  for (const { collection, name } of RETIRED_GLOBAL_UNIQUES) expect(await indexNames(collection), collection).toContain(name);
});

test("BP-665: one missing twin, the last one checked, drops nothing at all", async () => {
  await buildPerOrganisationTwins();
  await col("agentblocks").dropIndex("key_1_organisation_1");

  await expect(dropGlobalUniques(conn, { apply: true })).rejects.toThrow(/agentblocks\.key_1/);

  for (const { collection, name } of RETIRED_GLOBAL_UNIQUES) expect(await indexNames(collection), collection).toContain(name);
});

test("BP-665: a twin with another partial filter is no twin", async () => {
  await buildPerOrganisationTwins();
  await col("invitations").dropIndex("email_1_organisation_1");
  await col("invitations").createIndex({ email: 1, organisation: 1 }, { unique: true, partialFilterExpression: { status: "expired" } });

  await expect(dropGlobalUniques(conn, { apply: true })).rejects.toThrow(/invitations\.email_1/);
  expect(await indexNames("invitations")).toContain("email_1");
});

test("BP-665: a dry run names the seven it would drop and drops none; apply drops them and keeps the twins", async () => {
  await buildPerOrganisationTwins();

  const dry = await dropGlobalUniques(conn, { apply: false });
  expect(dry.map((o) => o.state)).toEqual(Array(7).fill("would drop"));
  for (const { collection, name } of RETIRED_GLOBAL_UNIQUES) expect(await indexNames(collection), collection).toContain(name);

  const applied = await dropGlobalUniques(conn, { apply: true });
  expect(applied.map((o) => o.state)).toEqual(Array(7).fill("dropped"));
  for (const { collection, name, twin } of RETIRED_GLOBAL_UNIQUES) {
    const names = await indexNames(collection);
    expect(names, collection).not.toContain(name);
    expect(names, collection).toContain(Object.entries(twin).map(([k, v]) => `${k}_${v}`).join("_"));
  }

  expect((await dropGlobalUniques(conn, { apply: true })).map((o) => o.state)).toEqual(Array(7).fill("absent"));
});

test("BP-665: once dropped, the same username, e-mail and project key live in two organisations", async () => {
  await buildPerOrganisationTwins();
  await dropGlobalUniques(conn, { apply: true });

  await col("users").insertOne({ username: "alice", email: "alice@x.test", organisation: OTHER_ORGANISATION });
  await col("users").insertOne({ username: "alice", email: "alice@x.test", organisation: THIRD_ORGANISATION });
  await col("projects").insertOne({ key: "SAME", organisation: OTHER_ORGANISATION });
  await col("projects").insertOne({ key: "SAME", organisation: THIRD_ORGANISATION });
  await expect(col("users").insertOne({ username: "alice", organisation: OTHER_ORGANISATION })).rejects.toThrow(/E11000/);

  expect(await col("users").countDocuments({ username: "alice" })).toBe(2);
});

const insertOutcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "inserted" as const,
    (err) => ({ refused: duplicateKeyField(err) })
  );

test("seven per-organisation uniques are declared, so none can drop out of the checks below", () => {
  expect(declaredPerOrganisationUniques).toHaveLength(7);
});

for (const { model, fields, options } of declaredPerOrganisationUniques) {
  const chosen = Object.keys(fields).filter((key) => key !== "organisation");
  test(`${model} ${chosen.join("+")}: unique per organisation, as declared`, async () => {
    const fresh = col(`fresh_${model}_${chosen.join("_")}`);
    await fresh.createIndex(fields as never, { unique: true, ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}) });
    const partial = options.partialFilterExpression ?? {};
    const values = Object.fromEntries(chosen.map((key) => [key, `v-${key}`]));
    const inside = Object.fromEntries(Object.entries(partial).filter(([, v]) => typeof v === "string"));
    const row = (organisation: mongoose.Types.ObjectId, over: object = {}) => ({ ...values, ...inside, organisation, ...over });

    expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION)))).toBe("inserted");
    expect(await insertOutcome(fresh.insertOne(row(THIRD_ORGANISATION)))).toBe("inserted");
    expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION)))).toEqual({ refused: chosen[0] });

    if (partial.email) {
      expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION, { email: "", username: "b1" })))).toBe("inserted");
      expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION, { email: "", username: "b2" })))).toBe("inserted");
    }
    if (partial.status) {
      expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION, { status: "accepted" })))).toBe("inserted");
      expect(await insertOutcome(fresh.insertOne(row(OTHER_ORGANISATION, { status: "accepted" })))).toBe("inserted");
    }
  });
}

test("BP-667: Settings is one row per organisation, unique on the organisation alone", async () => {
  const declared = mongoose.model("Settings").schema.indexes();
  expect(declared).toContainEqual([{ organisation: 1 }, expect.objectContaining({ unique: true })]);

  const fresh = col("fresh_settings");
  await fresh.createIndex({ organisation: 1 }, { unique: true });
  expect(await insertOutcome(fresh.insertOne({ organisation: OTHER_ORGANISATION }))).toBe("inserted");
  expect(await insertOutcome(fresh.insertOne({ organisation: THIRD_ORGANISATION }))).toBe("inserted");
  expect(await insertOutcome(fresh.insertOne({ organisation: OTHER_ORGANISATION }))).toEqual({ refused: "organisation" });
});

