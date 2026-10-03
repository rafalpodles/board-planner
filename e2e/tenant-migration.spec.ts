import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI } from "./seed";
import "../src/models/all";
import { migrateToTenants, REPLACED_UNIQUE_INDEXES } from "../src/lib/tenant-migration";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant-field";

/**
 * BP-662. The migration runs against a real mongod, on a database of its own beside the suite's,
 * because the whole point is what MongoDB does with the old and new indexes — a stub cannot say.
 */

// The runner imports the models only to read their schemas; it must not build their indexes or
// create their collections, here or on the connections later specs open in this worker
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

// Beside the suite's database, named from it so two checkouts on one mongod keep their own
const LEGACY_DB = `${new URL(E2E_MONGODB_URI).pathname.slice(1).replace(/_e2e$/, "")}_tenantmig_e2e`;
const OTHER_TENANT = new mongoose.Types.ObjectId("0000000000000000000000aa");
const THIRD_TENANT = new mongoose.Types.ObjectId("0000000000000000000000bb");

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

// One fixture document per collection, and the extras above
const EXPECTED_DOCUMENTS: Record<string, number> = { users: 3, invitations: 3 };
const expectedIn = (collection: string) => EXPECTED_DOCUMENTS[collection] ?? 1;

function collections() {
  return mongoose.modelNames().filter((n) => n !== "Tenant").map((n) => mongoose.model(n).collection.name);
}

async function legacyDatabase() {
  conn = mongoose.createConnection(E2E_MONGODB_URI, { dbName: LEGACY_DB, autoIndex: false, autoCreate: false });
  await conn.asPromise();
  await conn.dropDatabase();
  const db = conn.db!;
  for (const [collection, indexes] of Object.entries(LEGACY_INDEXES)) {
    for (const { key, name, partial } of indexes) {
      await db.collection(collection).createIndex(key, {
        unique: true,
        name,
        ...(partial ? { partialFilterExpression: partial } : {}),
      });
    }
  }
  for (const name of collections()) {
    await db.collection(name).insertOne({
      legacy: name,
      username: `u-${name}`,
      email: `${name}@x.test`,
      key: name.toUpperCase(),
      tokenHash: `hash-${name}`,
    });
  }
  // What production has plenty of and the partial filters exist for: accounts with no e-mail, and
  // invitations that were answered long ago for an address that is invited again
  await db.collection("users").insertMany([
    { username: "blank-a", email: "" },
    { username: "blank-b", email: "" },
  ]);
  await db.collection("invitations").insertMany([
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-1" },
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-2" },
  ]);
  await db.collection("tenants").insertOne({
    _id: new mongoose.Types.ObjectId(),
    entitlements: { plan: "pro", features: [], customer: "Legacy Ltd", source: "env" },
  });
  return db;
}

test.beforeEach(async () => {
  await legacyDatabase();
});

test.afterEach(async () => {
  await conn.dropDatabase();
  await conn.close();
});

async function indexNames(collection: string) {
  return (await conn.db!.collection(collection).indexes()).map((i) => String(i.name));
}

async function wholeDatabase() {
  const db = conn.db!;
  const everything: Record<string, unknown> = {};
  for (const { name } of await db.listCollections().toArray()) {
    everything[name] = {
      documents: await db.collection(name).find({}).sort({ _id: 1 }).toArray(),
      indexes: (await db.collection(name).indexes()).map((i) => i.name).sort(),
    };
  }
  return JSON.stringify(everything);
}

test("a dry run reports what it would do and writes nothing", async () => {
  const before = await wholeDatabase();

  const report = await migrateToTenants(conn, { apply: false });

  expect(report.applied).toBe(false);
  expect(report.tenantRow).toBe("re-keyed");
  for (const name of collections()) expect(report.withoutTenant[name], name).toBe(expectedIn(name));
  expect(report.indexesStillOld).toHaveLength(REPLACED_UNIQUE_INDEXES.length);

  expect(await wholeDatabase()).toBe(before);
});

test("apply gives every document the default tenant, re-keys the legacy tenant row and replaces the old uniques", async () => {
  const report = await migrateToTenants(conn, { apply: true });

  expect(report.tenantRow).toBe("re-keyed");
  for (const name of collections()) {
    expect(await conn.db!.collection(name).countDocuments({ tenant: DEFAULT_TENANT_ID }), name).toBe(expectedIn(name));
    expect(await conn.db!.collection(name).countDocuments({ tenant: null }), name).toBe(0);
  }

  const tenants = await conn.db!.collection("tenants").find({}).toArray();
  expect(tenants).toHaveLength(1);
  expect(String(tenants[0]._id)).toBe(String(DEFAULT_TENANT_ID));
  expect(tenants[0].entitlements.customer).toBe("Legacy Ltd");

  for (const { model, old, replacement } of REPLACED_UNIQUE_INDEXES) {
    const collection = mongoose.model(model).collection.name;
    const names = await indexNames(collection);
    expect(names, `${collection} keeps ${old}`).not.toContain(old);
    expect(names, `${collection} lacks ${replacement}`).toContain(replacement);
  }
});

test("a second run changes nothing", async () => {
  await migrateToTenants(conn, { apply: true });
  const again = await migrateToTenants(conn, { apply: true });

  expect(again.tenantRow).toBe("present");
  expect(Object.values(again.withoutTenant).every((n) => n === 0)).toBe(true);
  expect(again.indexesDropped).toEqual([]);
  expect(again.indexesStillOld).toEqual([]);
});

test("a tenant added after the migration is left alone by a re-run", async () => {
  await migrateToTenants(conn, { apply: true });
  await conn.db!.collection("tenants").insertOne({ _id: OTHER_TENANT, entitlements: { plan: "free", features: [], source: "none" } });
  await conn.db!.collection("projects").insertOne({ key: "OTHER", tenant: OTHER_TENANT });
  await conn.db!.collection("projects").insertOne({ key: "LATE" });

  await migrateToTenants(conn, { apply: true });

  expect(await conn.db!.collection("tenants").countDocuments({})).toBe(2);
  expect(await conn.db!.collection("projects").findOne({ key: "OTHER" })).toMatchObject({ tenant: OTHER_TENANT });
  expect(await conn.db!.collection("projects").findOne({ key: "LATE" })).toMatchObject({ tenant: DEFAULT_TENANT_ID });
});

test("an empty tenants table gets the default tenant, on the free plan", async () => {
  await conn.db!.collection("tenants").deleteMany({});

  const report = await migrateToTenants(conn, { apply: true });

  expect(report.tenantRow).toBe("created");
  const rows = await conn.db!.collection("tenants").find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(String(rows[0]._id)).toBe(String(DEFAULT_TENANT_ID));
  expect(rows[0].entitlements).toMatchObject({ plan: "free", source: "none" });
});

test("a re-key that died between its insert and its delete is finished by the next run", async () => {
  const legacy = await conn.db!.collection("tenants").findOne({});
  await conn.db!.collection("tenants").insertOne({ ...legacy, _id: DEFAULT_TENANT_ID, rekeyedFrom: legacy!._id });

  const report = await migrateToTenants(conn, { apply: true });

  expect(report.tenantRow).toBe("present");
  const rows = await conn.db!.collection("tenants").find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(String(rows[0]._id)).toBe(String(DEFAULT_TENANT_ID));
  expect(rows[0].rekeyedFrom).toBeUndefined();
});

test("the partial filters survive: blank e-mails and answered invitations stay non-unique", async () => {
  await migrateToTenants(conn, { apply: true });

  await conn.db!.collection("users").insertOne({ tenant: DEFAULT_TENANT_ID, username: "blank-c", email: "" });
  await conn.db!.collection("invitations").insertOne({
    tenant: DEFAULT_TENANT_ID,
    email: "again@x.test",
    status: "accepted",
    tokenHash: "hash-old-3",
  });
  await conn.db!.collection("invitations").insertOne({
    tenant: DEFAULT_TENANT_ID,
    email: "again@x.test",
    status: "pending",
    tokenHash: "hash-new-1",
  });
  const secondPending = await conn.db!.collection("invitations")
    .insertOne({ tenant: DEFAULT_TENANT_ID, email: "again@x.test", status: "pending", tokenHash: "hash-new-2" })
    .then(
      () => "inserted",
      (err) => (/E11000/.test(String(err)) ? "refused" : String(err))
    );
  expect(secondPending).toBe("refused");
});

test("two tenant rows and none on the default id are refused rather than guessed at", async () => {
  await conn.db!.collection("tenants").insertOne({ _id: new mongoose.Types.ObjectId(), entitlements: {} });

  await expect(migrateToTenants(conn, { apply: true })).rejects.toThrow(/cannot tell which is the legacy one/);
});

const DUPLICATES: { collection: string; label: string; doc: (tenant: mongoose.Types.ObjectId, n: number) => object }[] = [
  { collection: "users", label: "users by username", doc: (tenant, n) => ({ tenant, username: "shared", email: n ? `m${n}@x.test` : "shared@x.test" }) },
  { collection: "users", label: "users by e-mail", doc: (tenant, n) => ({ tenant, username: `by-mail-${n}`, email: "same@x.test" }) },
  { collection: "projects", label: "projects", doc: (tenant) => ({ tenant, key: "SHARED" }) },
  { collection: "workers", label: "workers", doc: (tenant) => ({ tenant, name: "mac", host: "laptop" }) },
  { collection: "identities", label: "identities", doc: (tenant) => ({ tenant, issuer: "https://accounts.example", subject: "42" }) },
  { collection: "invitations", label: "invitations", doc: (tenant) => ({ tenant, email: "invitee@x.test", status: "pending", tokenHash: String(new mongoose.Types.ObjectId()) }) },
  { collection: "agentblocks", label: "agentblocks", doc: (tenant) => ({ tenant, key: "reviewer" }) },
];

for (const { collection, label, doc } of DUPLICATES) {
  test(`${label}: before the migration a second tenant cannot reuse the value, after it two tenants can and one tenant cannot`, async () => {
    const col = conn.db!.collection(collection);
    const legacyDuplicate = doc(OTHER_TENANT, 1);
    await col.deleteMany({});
    await col.insertOne({ ...doc(OTHER_TENANT, 0) });

    const blockedBefore = await col.insertOne({ ...legacyDuplicate, _id: new mongoose.Types.ObjectId() }).then(
      () => false,
      (err) => /E11000/.test(String(err))
    );
    expect(blockedBefore, `the legacy ${collection} index should refuse a second tenant's copy`).toBe(true);

    await migrateToTenants(conn, { apply: true });
    await col.deleteMany({});
    await col.insertOne({ ...doc(OTHER_TENANT, 0) });

    await col.insertOne({ ...doc(THIRD_TENANT, 1), _id: new mongoose.Types.ObjectId() });
    expect(await col.countDocuments({})).toBe(2);

    const sameTenant = await col.insertOne({ ...doc(OTHER_TENANT, 2), _id: new mongoose.Types.ObjectId() }).then(
      () => "inserted",
      (err) => (/E11000/.test(String(err)) ? "refused" : String(err))
    );
    expect(sameTenant).toBe("refused");
  });
}
