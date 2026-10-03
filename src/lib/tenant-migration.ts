import mongoose from "mongoose";
import { existsSync } from "node:fs";
import { join } from "node:path";
import "@/models/all";
import { DEFAULT_TENANT_ID } from "./tenant-field";

const TENANT_MODEL = "Tenant";
const TENANT_COLLECTION = mongoose.model(TENANT_MODEL).collection.name;

export const REPLACED_UNIQUE_INDEXES = [
  { model: "User", old: "username_1", replacement: "tenant_1_username_1" },
  { model: "User", old: "email_1", replacement: "tenant_1_email_1" },
  { model: "Project", old: "key_1", replacement: "tenant_1_key_1" },
  { model: "Worker", old: "name_1_host_1", replacement: "tenant_1_name_1_host_1" },
  { model: "Identity", old: "issuer_1_subject_1", replacement: "tenant_1_issuer_1_subject_1" },
  { model: "Invitation", old: "email_1", replacement: "tenant_1_email_1" },
  { model: "AgentBlock", old: "key_1", replacement: "tenant_1_key_1" },
] as const;

export interface TenantMigrationReport {
  applied: boolean;
  tenantRow: "present" | "created" | "re-keyed";
  withoutTenant: Record<string, number>;
  indexesBuilt: string[];
  indexesDropped: string[];
  indexesStillOld: string[];
}

function bound(connection: mongoose.Connection, name: string): mongoose.Model<mongoose.AnyObject> {
  return connection.model(name, mongoose.model(name).schema) as mongoose.Model<mongoose.AnyObject>;
}

function scopedModels(connection: mongoose.Connection) {
  return mongoose
    .modelNames()
    .filter((name) => name !== TENANT_MODEL)
    .map((name) => bound(connection, name));
}

async function indexNames(db: mongoose.mongo.Db, collection: string): Promise<string[]> {
  try {
    return (await db.collection(collection).indexes()).map((i) => String(i.name));
  } catch {
    return [];
  }
}

async function normaliseDefaultTenant(
  db: mongoose.mongo.Db,
  apply: boolean
): Promise<Pick<TenantMigrationReport, "tenantRow">> {
  const tenants = db.collection(TENANT_COLLECTION);
  const rows = await tenants.find({}).toArray();
  const fixed = rows.find((row) => DEFAULT_TENANT_ID.equals(row._id));

  if (fixed) {
    // The re-key below inserts before it deletes, so a process that died between the two left
    // both rows; the marker says which one is the leftover.
    const leftover = fixed.rekeyedFrom ? rows.find((row) => row._id.equals(fixed.rekeyedFrom)) : undefined;
    if (apply && fixed.rekeyedFrom) {
      if (leftover) await tenants.deleteOne({ _id: leftover._id });
      await tenants.updateOne({ _id: fixed._id }, { $unset: { rekeyedFrom: "" } });
    }
    return { tenantRow: "present" };
  }

  if (rows.length > 1) {
    throw new Error(
      `${rows.length} tenant rows and none with the default id ${DEFAULT_TENANT_ID}: cannot tell which is the legacy one`
    );
  }

  const seed = { entitlements: { plan: "free", features: [], source: "none" } };
  const legacy = rows[0];
  if (apply) {
    await tenants.insertOne({ ...(legacy ?? seed), _id: DEFAULT_TENANT_ID, ...(legacy ? { rekeyedFrom: legacy._id } : {}) });
    if (legacy) {
      await tenants.deleteOne({ _id: legacy._id });
      await tenants.updateOne({ _id: DEFAULT_TENANT_ID }, { $unset: { rekeyedFrom: "" } });
    }
  }
  return { tenantRow: legacy ? "re-keyed" : "created" };
}

/** A snapshot is only a safety net if it holds every collection; one that misses a file is not. */
export function collectionsMissingFromSnapshot(snapshotDir: string, collections: string[]): string[] {
  return collections.filter((name) => !existsSync(join(snapshotDir, `${name}.json`)));
}

export async function migrateToTenants(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<TenantMigrationReport> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");

  const tenant = await normaliseDefaultTenant(db, apply);
  const models = scopedModels(connection);

  const withoutTenant: Record<string, number> = {};
  for (const model of models) {
    const name = model.collection.name;
    const missing = await db.collection(name).countDocuments({ tenant: null });
    withoutTenant[name] = missing;
    if (apply && missing) {
      await db.collection(name).updateMany({ tenant: null }, { $set: { tenant: DEFAULT_TENANT_ID } });
    }
  }

  const indexesBuilt: string[] = [];
  const indexesDropped: string[] = [];
  const indexesStillOld: string[] = [];
  for (const { model, old, replacement } of REPLACED_UNIQUE_INDEXES) {
    const target = bound(connection, model);
    const collection = target.collection.name;
    if (apply) await target.createIndexes();
    const present = await indexNames(db, collection);
    if (present.includes(replacement)) indexesBuilt.push(`${collection}.${replacement}`);
    if (!present.includes(old)) continue;
    if (apply && present.includes(replacement)) {
      await db.collection(collection).dropIndex(old);
      indexesDropped.push(`${collection}.${old}`);
    } else {
      indexesStillOld.push(`${collection}.${old}`);
    }
  }

  if (apply) {
    for (const model of models) {
      const left = await db.collection(model.collection.name).countDocuments({ tenant: null });
      if (left) throw new Error(`${model.collection.name}: ${left} documents still have no tenant after the backfill`);
    }
  }

  return {
    applied: apply,
    ...tenant,
    withoutTenant,
    indexesBuilt,
    indexesDropped,
    indexesStillOld,
  };
}
