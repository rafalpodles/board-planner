import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, e2eDatabaseName } from "./seed";
import "../src/models/all";
import { backfillTenants, backfillTenantsOnce, scopedModelNames } from "../src/lib/tenant-migration";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant-field";
import { duplicateKeyField } from "../src/lib/mongo-errors";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const LEGACY_DB = `${e2eDatabaseName().replace(/_e2e$/, "")}_tenantmig_e2e`;
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

const LEGACY_TENANT_ROW = { _id: new mongoose.Types.ObjectId("0000000000000000000000cc"), entitlements: { plan: "free", features: [], source: "none" } };
const PAID_TENANT_ROW = { _id: new mongoose.Types.ObjectId("0000000000000000000000dd"), entitlements: { plan: "pro", features: [], customer: "Acme", source: "service" } };

let conn: mongoose.Connection;

const scopedCollections = () => scopedModelNames().map((name) => mongoose.model(name).collection.name);
const expectedIn = (collection: string) => ({ users: 3, invitations: 3 })[collection as "users"] ?? 1;

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
  for (const name of [...scopedCollections(), "ratelimits"]) {
    await db.collection(name).insertOne({
      legacy: name,
      username: `u-${name}`,
      email: `${name}@x.test`,
      key: name.toUpperCase(),
      tokenHash: `hash-${name}`,
    });
  }
  await db.collection("users").insertMany([
    { username: "blank-a", email: "" },
    { username: "blank-b", email: "" },
  ]);
  await db.collection("invitations").insertMany([
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-1" },
    { email: "again@x.test", status: "accepted", tokenHash: "hash-old-2" },
  ]);
  await db.collection("tenants").insertMany([LEGACY_TENANT_ROW, PAID_TENANT_ROW]);
}

test.beforeEach(legacyDatabase);

test.afterEach(async () => {
  await conn.dropDatabase();
  await conn.close();
});

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

  const report = await backfillTenants(conn, { apply: false });

  expect(report).toMatchObject({ applied: false, defaultTenant: "created", legacyTenantRows: 1 });
  for (const name of scopedCollections()) expect(report.withoutTenant[name], name).toBe(expectedIn(name));
  expect(await wholeDatabase()).toBe(before);
});

test("apply gives every scoped document the default tenant, makes the default tenant row, and touches neither the throttle nor an index", async () => {
  const indexesBefore = await conn.db!.collection("users").indexes();

  await backfillTenants(conn, { apply: true });

  for (const name of scopedCollections()) {
    expect(await conn.db!.collection(name).countDocuments({ tenant: DEFAULT_TENANT_ID }), name).toBe(expectedIn(name));
    expect(await conn.db!.collection(name).countDocuments({ tenant: null }), name).toBe(0);
  }
  expect(await conn.db!.collection("ratelimits").countDocuments({ tenant: null })).toBe(1);
  expect(await conn.db!.collection("tenants").findOne({ _id: DEFAULT_TENANT_ID })).toMatchObject({
    entitlements: { plan: "free", source: "none" },
  });
  expect(await conn.db!.collection("tenants").countDocuments({})).toBe(3);
  expect(await conn.db!.collection("users").indexes()).toEqual(indexesBefore);
});

test("a second run changes nothing", async () => {
  await backfillTenants(conn, { apply: true });

  const again = await backfillTenants(conn, { apply: true });

  expect(again.defaultTenant).toBe("present");
  expect(Object.values(again.withoutTenant).every((n) => n === 0)).toBe(true);
});

test("a late tenant-less row is given the default tenant and another tenant's row is left alone", async () => {
  await backfillTenants(conn, { apply: true });
  await conn.db!.collection("projects").insertOne({ key: "OTHER", tenant: OTHER_TENANT });
  await conn.db!.collection("projects").insertOne({ key: "LATE" });

  await backfillTenants(conn, { apply: true });

  expect(await conn.db!.collection("projects").findOne({ key: "OTHER" })).toMatchObject({ tenant: OTHER_TENANT });
  expect(await conn.db!.collection("projects").findOne({ key: "LATE" })).toMatchObject({ tenant: DEFAULT_TENANT_ID });
});

test("start-up runs the backfill once, removes the legacy tenant row that holds nothing and keeps a paid one", async () => {
  const first = await backfillTenantsOnce(conn);

  expect(first).not.toBeNull();
  const rows = await conn.db!.collection("tenants").find({}).toArray();
  expect(rows.map((r) => String(r._id)).sort()).toEqual([String(DEFAULT_TENANT_ID), String(PAID_TENANT_ROW._id)].sort());
  expect((rows.find((r) => DEFAULT_TENANT_ID.equals(r._id)) as { backfilledAt?: unknown }).backfilledAt).toBeInstanceOf(Date);

  await conn.db!.collection("projects").insertOne({ key: "AFTER" });
  expect(await backfillTenantsOnce(conn)).toBeNull();
  expect(await conn.db!.collection("projects").countDocuments({ key: "AFTER", tenant: null })).toBe(1);
});

test("the per-tenant uniques build beside the old ones on data that already has blank e-mails and answered invitations", async () => {
  await backfillTenants(conn, { apply: true });

  for (const name of ["User", "Project", "Worker", "Identity", "Invitation", "AgentBlock"]) {
    await (conn.model(name, mongoose.model(name).schema) as mongoose.Model<mongoose.AnyObject>).createIndexes();
  }

  const names = async (collection: string) => (await conn.db!.collection(collection).indexes()).map((i) => i.name);
  expect(await names("users")).toEqual(expect.arrayContaining(["username_1", "username_1_tenant_1", "email_1", "email_1_tenant_1"]));
  expect(await names("projects")).toEqual(expect.arrayContaining(["key_1", "key_1_tenant_1"]));
  expect(await names("workers")).toEqual(expect.arrayContaining(["name_1_host_1", "name_1_host_1_tenant_1"]));
  expect(await names("identities")).toEqual(expect.arrayContaining(["issuer_1_subject_1", "issuer_1_subject_1_tenant_1"]));
  expect(await names("invitations")).toEqual(expect.arrayContaining(["email_1", "email_1_tenant_1"]));
  expect(await names("agentblocks")).toEqual(expect.arrayContaining(["key_1", "key_1_tenant_1"]));
});

type Spec = { model: string; fields: Record<string, number>; options: { partialFilterExpression?: Record<string, unknown> } };

const declaredPerTenantUniques: Spec[] = scopedModelNames().flatMap((model) =>
  mongoose
    .model(model)
    .schema.indexes()
    .filter(([fields, options]) => options?.unique && "tenant" in fields)
    .map(([fields, options]) => ({ model, fields: fields as Record<string, number>, options: options as Spec["options"] }))
);

const insertOutcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "inserted" as const,
    (err) => ({ refused: duplicateKeyField(err) })
  );

for (const { model, fields, options } of declaredPerTenantUniques) {
  const chosen = Object.keys(fields).filter((key) => key !== "tenant");
  test(`${model} ${chosen.join("+")}: unique per tenant, as declared`, async () => {
    const col = conn.db!.collection(`fresh_${model}_${chosen.join("_")}`);
    await col.createIndex(fields as never, { unique: true, ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}) });
    const partial = options.partialFilterExpression ?? {};
    const values = Object.fromEntries(chosen.map((key) => [key, `v-${key}`]));
    const inside = Object.fromEntries(Object.entries(partial).filter(([, v]) => typeof v === "string"));
    const row = (tenant: mongoose.Types.ObjectId, over: object = {}) => ({ ...values, ...inside, tenant, ...over });

    expect(await insertOutcome(col.insertOne(row(OTHER_TENANT)))).toBe("inserted");
    expect(await insertOutcome(col.insertOne(row(THIRD_TENANT)))).toBe("inserted");
    expect(await insertOutcome(col.insertOne(row(OTHER_TENANT)))).toEqual({ refused: chosen[0] });

    if (partial.email) {
      const blank = { email: "" };
      expect(await insertOutcome(col.insertOne(row(OTHER_TENANT, { ...blank, username: "b1" })))).toBe("inserted");
      expect(await insertOutcome(col.insertOne(row(OTHER_TENANT, { ...blank, username: "b2" })))).toBe("inserted");
    }
    if (partial.status) {
      expect(await insertOutcome(col.insertOne(row(OTHER_TENANT, { status: "accepted" })))).toBe("inserted");
      expect(await insertOutcome(col.insertOne(row(OTHER_TENANT, { status: "accepted" })))).toBe("inserted");
    }
  });
}
