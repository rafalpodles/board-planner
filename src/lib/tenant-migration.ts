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

type IndexKey = Record<string, 1>;

export const RETIRED_GLOBAL_UNIQUES: { collection: string; name: string; twin: IndexKey }[] = [
  { collection: "users", name: "username_1", twin: { username: 1, tenant: 1 } },
  { collection: "users", name: "email_1", twin: { email: 1, tenant: 1 } },
  { collection: "projects", name: "key_1", twin: { key: 1, tenant: 1 } },
  { collection: "workers", name: "name_1_host_1", twin: { name: 1, host: 1, tenant: 1 } },
  { collection: "identities", name: "issuer_1_subject_1", twin: { issuer: 1, subject: 1, tenant: 1 } },
  { collection: "invitations", name: "email_1", twin: { email: 1, tenant: 1 } },
  { collection: "agentblocks", name: "key_1", twin: { key: 1, tenant: 1 } },
];

export type RetiredIndexOutcome = { collection: string; name: string; state: "absent" | "would drop" | "dropped" };

export async function dropGlobalUniques(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<RetiredIndexOutcome[]> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const outcomes: RetiredIndexOutcome[] = [];
  for (const { collection, name, twin } of RETIRED_GLOBAL_UNIQUES) {
    const indexes = existing.has(collection) ? await db.collection(collection).indexes() : [];
    if (!indexes.some((index) => index.name === name)) {
      outcomes.push({ collection, name, state: "absent" });
      continue;
    }
    const hasTwin = indexes.some((index) => index.unique && JSON.stringify(index.key) === JSON.stringify(twin));
    if (!hasTwin) {
      throw new Error(`${collection}.${name}: its per-tenant twin ${JSON.stringify(twin)} is not built yet — start the app once so it builds it, then run this again`);
    }
    if (apply) await db.collection(collection).dropIndex(name);
    outcomes.push({ collection, name, state: apply ? "dropped" : "would drop" });
  }
  return outcomes;
}

