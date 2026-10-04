import mongoose from "mongoose";
import "@/models/all";
import { DEFAULT_TENANT_ID } from "./tenant-field";

export const UNSCOPED_MODELS = ["Tenant", "RateLimit"];

export const scopedModelNames = () =>
  mongoose.modelNames().filter((name) => !UNSCOPED_MODELS.includes(name));

export async function backfillTenants(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<{ total: number; byCollection: Record<string, number> }> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");

  const byCollection: Record<string, number> = {};
  let total = 0;
  for (const name of scopedModelNames()) {
    const collection = db.collection(mongoose.model(name).collection.name);
    const count = apply
      ? (await collection.updateMany({ tenant: null }, { $set: { tenant: DEFAULT_TENANT_ID } })).matchedCount
      : await collection.countDocuments({ tenant: null });
    byCollection[collection.collectionName] = count;
    total += count;
  }
  return { total, byCollection };
}

export async function ensureOrganisation(
  connection: mongoose.Connection,
  { apply, name }: { apply: boolean; name: string }
): Promise<"present" | "created" | "re-keyed"> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const tenants = db.collection(mongoose.model("Tenant").collection.name);

  const rows = await tenants.find({}).toArray();
  if (rows.some((row) => DEFAULT_TENANT_ID.equals(row._id))) {
    if (apply) await tenants.updateOne({ _id: DEFAULT_TENANT_ID }, { $set: { name } });
    return "present";
  }
  if (rows.length > 1) throw new Error(`${rows.length} tenant rows and none with the default id: cannot tell which is the organisation`);

  const [legacy] = rows;
  if (apply) {
    const { _id, ...seed } = new (mongoose.model("Tenant"))({ _id: DEFAULT_TENANT_ID }).toObject();
    await tenants.insertOne({ ...seed, ...(legacy ?? {}), _id, name });
    if (legacy) await tenants.deleteOne({ _id: legacy._id });
  }
  return legacy ? "re-keyed" : "created";
}
