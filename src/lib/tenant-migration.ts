import mongoose from "mongoose";
import "@/models/all";
import { DEFAULT_TENANT_ID } from "./tenant-field";

export const UNSCOPED_MODELS = ["Tenant", "RateLimit"];

export const scopedModelNames = () =>
  mongoose.modelNames().filter((name) => !UNSCOPED_MODELS.includes(name));

const SECOND_PASS_MS = 5 * 60_000;

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

export function startTenantBackfill(connection: mongoose.Connection = mongoose.connection): void {
  const pass = () =>
    backfillTenants(connection, { apply: true })
      .then(({ total }) => {
        if (total > 0) console.log(`Gave ${total} document(s) the default tenant`);
      })
      .catch((error) => {
        console.error("Failed to give every document a tenant:", error);
      });

  void pass();
  setTimeout(() => void pass(), SECOND_PASS_MS).unref();
}
