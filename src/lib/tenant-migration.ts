import mongoose from "mongoose";
import "@/models/all";
import { DEFAULT_TENANT_ID } from "./tenant-field";

const UNSCOPED_MODELS = {
  Tenant: "is the tenant",
  RateLimit: "its _id is a throttle key shared by every tenant",
} as const;

export const unscopedModelNames = () => Object.keys(UNSCOPED_MODELS);

export const scopedModelNames = () =>
  mongoose.modelNames().filter((name) => !(name in UNSCOPED_MODELS));

export interface TenantBackfillReport {
  applied: boolean;
  defaultTenant: "present" | "created";
  legacyTenantRows: number;
  withoutTenant: Record<string, number>;
}

const tenantCollection = () => mongoose.model("Tenant").collection.name;

const SEED_SHAPED_LEGACY_ROW = {
  _id: { $ne: DEFAULT_TENANT_ID },
  "entitlements.plan": "free",
  "entitlements.source": "none",
  "entitlements.features": { $size: 0 },
  "entitlements.customer": { $exists: false },
};

export async function backfillTenants(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<TenantBackfillReport> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const tenants = db.collection(tenantCollection());

  const defaultTenant = (await tenants.countDocuments({ _id: DEFAULT_TENANT_ID })) ? "present" : "created";
  const legacyTenantRows = await tenants.countDocuments(SEED_SHAPED_LEGACY_ROW);
  if (apply) {
    const { _id, ...seed } = new (mongoose.model("Tenant"))({ _id: DEFAULT_TENANT_ID }).toObject();
    await tenants.updateOne({ _id }, { $setOnInsert: seed }, { upsert: true });
  }

  const withoutTenant: Record<string, number> = {};
  for (const name of scopedModelNames()) {
    const collection = db.collection(mongoose.model(name).collection.name);
    withoutTenant[collection.collectionName] = apply
      ? (await collection.updateMany({ tenant: null }, { $set: { tenant: DEFAULT_TENANT_ID } })).matchedCount
      : await collection.countDocuments({ tenant: null });
  }

  return { applied: apply, defaultTenant, legacyTenantRows, withoutTenant };
}

export async function backfillTenantsOnce(
  connection: mongoose.Connection = mongoose.connection
): Promise<TenantBackfillReport | null> {
  const tenants = connection.db!.collection(tenantCollection());
  if (await tenants.countDocuments({ _id: DEFAULT_TENANT_ID, backfilledAt: { $exists: true } })) return null;

  const report = await backfillTenants(connection, { apply: true });
  await tenants.deleteMany(SEED_SHAPED_LEGACY_ROW);
  await tenants.updateOne({ _id: DEFAULT_TENANT_ID }, { $set: { backfilledAt: new Date() } });
  return report;
}
