import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import { backfillTenants, scopedModelNames } from "../src/lib/tenant-migration";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant-field";
import { duplicateKeyField } from "../src/lib/mongo-errors";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const LEGACY_DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_tenantmig_e2e`;
const OTHER_TENANT = new mongoose.Types.ObjectId("0000000000000000000000aa");
const THIRD_TENANT = new mongoose.Types.ObjectId("0000000000000000000000bb");
const LEGACY_TENANT_ROW = { _id: new mongoose.Types.ObjectId("0000000000000000000000cc"), entitlements: { plan: "pro", features: [], source: "service" } };

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
  await col(collectionOf("Tenant")).insertOne(LEGACY_TENANT_ROW);
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

  const { total, byCollection } = await backfillTenants(conn, { apply: false });

  for (const name of scopedCollections()) expect(byCollection[name], name).toBe(expectedIn(name));
  expect(total).toBe(scopedCollections().reduce((sum, name) => sum + expectedIn(name), 0));
  expect(await wholeDatabase()).toBe(before);
});

test("apply gives every scoped document the default tenant and touches nothing else", async () => {
  const throttleAndTenants = async () =>
    JSON.stringify([await col(collectionOf("RateLimit")).find({}).toArray(), await col(collectionOf("Tenant")).find({}).toArray()]);
  const untouchedBefore = await throttleAndTenants();
  const indexesBefore = await col("users").indexes();

  await backfillTenants(conn, { apply: true });

  for (const name of scopedCollections()) {
    expect(await col(name).countDocuments({ tenant: DEFAULT_TENANT_ID }), name).toBe(expectedIn(name));
    expect(await col(name).countDocuments({ tenant: null }), name).toBe(0);
  }
  expect(await throttleAndTenants()).toBe(untouchedBefore);
  expect(await col("users").indexes()).toEqual(indexesBefore);
});

test("a second run gives nothing", async () => {
  await backfillTenants(conn, { apply: true });

  const { total } = await backfillTenants(conn, { apply: true });

  expect(total).toBe(0);
});

test("a late row, with the field missing or null, is given the default tenant and another tenant's row is left alone", async () => {
  await backfillTenants(conn, { apply: true });
  await col("projects").insertMany([{ key: "OTHER", tenant: OTHER_TENANT }, { key: "MISSING" }, { key: "NULLED", tenant: null }]);

  const { total } = await backfillTenants(conn, { apply: true });

  expect(total).toBe(2);
  expect(await col("projects").findOne({ key: "OTHER" })).toMatchObject({ tenant: OTHER_TENANT });
  expect(await col("projects").findOne({ key: "MISSING" })).toMatchObject({ tenant: DEFAULT_TENANT_ID });
  expect(await col("projects").findOne({ key: "NULLED" })).toMatchObject({ tenant: DEFAULT_TENANT_ID });
});

type Spec = { model: string; fields: Record<string, number>; options: { partialFilterExpression?: Record<string, unknown> } };

const declaredPerTenantUniques: Spec[] = scopedModelNames().flatMap((model) =>
  mongoose
    .model(model)
    .schema.indexes()
    .filter(([fields, options]) => options?.unique && "tenant" in fields)
    .map(([fields, options]) => ({ model, fields: fields as Record<string, number>, options: options as Spec["options"] }))
);

test("the per-tenant uniques build beside the old ones on data that has blank e-mails and answered invitations", async () => {
  await backfillTenants(conn, { apply: true });

  for (const model of new Set(declaredPerTenantUniques.map((u) => u.model))) {
    await (conn.model(model, mongoose.model(model).schema) as mongoose.Model<mongoose.AnyObject>).createIndexes();
  }

  for (const { model, fields } of declaredPerTenantUniques) {
    const names = (await col(collectionOf(model)).indexes()).map((i) => i.name);
    expect(names, model).toContain(Object.entries(fields).map(([k, v]) => `${k}_${v}`).join("_"));
    expect(names.length, `${model} keeps its global twin`).toBeGreaterThan(2);
  }
});

const insertOutcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "inserted" as const,
    (err) => ({ refused: duplicateKeyField(err) })
  );

test("seven per-tenant uniques are declared, so none can drop out of the checks below", () => {
  expect(declaredPerTenantUniques).toHaveLength(7);
});

for (const { model, fields, options } of declaredPerTenantUniques) {
  const chosen = Object.keys(fields).filter((key) => key !== "tenant");
  test(`${model} ${chosen.join("+")}: unique per tenant, as declared`, async () => {
    const fresh = col(`fresh_${model}_${chosen.join("_")}`);
    await fresh.createIndex(fields as never, { unique: true, ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}) });
    const partial = options.partialFilterExpression ?? {};
    const values = Object.fromEntries(chosen.map((key) => [key, `v-${key}`]));
    const inside = Object.fromEntries(Object.entries(partial).filter(([, v]) => typeof v === "string"));
    const row = (tenant: mongoose.Types.ObjectId, over: object = {}) => ({ ...values, ...inside, tenant, ...over });

    expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT)))).toBe("inserted");
    expect(await insertOutcome(fresh.insertOne(row(THIRD_TENANT)))).toBe("inserted");
    expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT)))).toEqual({ refused: chosen[0] });

    if (partial.email) {
      expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT, { email: "", username: "b1" })))).toBe("inserted");
      expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT, { email: "", username: "b2" })))).toBe("inserted");
    }
    if (partial.status) {
      expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT, { status: "accepted" })))).toBe("inserted");
      expect(await insertOutcome(fresh.insertOne(row(OTHER_TENANT, { status: "accepted" })))).toBe("inserted");
    }
  });
}
