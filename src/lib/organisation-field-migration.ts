import mongoose from "mongoose";
import { scopedModelNames } from "./organisation-migration";

// TODO(BP-896): delete this file, its script and its tests once production has been finalised
export const LEGACY_FIELD = "tenant";
export const LEGACY_COLLECTION = "tenants";
const ORGANISATIONS = "organisations";

type Report = { total: number; byCollection: Record<string, number> };

function handle(connection: mongoose.Connection) {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  return db;
}

const scopedCollections = () => scopedModelNames().map((name) => mongoose.model(name).collection.name);
const uncopied = { [LEGACY_FIELD]: { $exists: true }, organisation: { $exists: false } };

export async function copyLegacyField(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<Report & { organisationRows: number }> {
  const db = handle(connection);
  const byCollection: Record<string, number> = {};
  let total = 0;
  for (const name of scopedCollections()) {
    const collection = db.collection(name);
    const count = apply
      ? (await collection.updateMany(uncopied, [{ $set: { organisation: `$${LEGACY_FIELD}` } }])).modifiedCount
      : await collection.countDocuments(uncopied);
    byCollection[name] = count;
    total += count;
  }

  let organisationRows = 0;
  const organisations = db.collection(ORGANISATIONS);
  for (const { _id, ...row } of await db.collection(LEGACY_COLLECTION).find({}).toArray()) {
    if (await organisations.countDocuments({ _id }, { limit: 1 })) continue;
    if (apply) await organisations.updateOne({ _id }, { $setOnInsert: row }, { upsert: true });
    organisationRows += 1;
  }
  return { total, byCollection, organisationRows };
}

export async function finaliseLegacyField(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<Report & { droppedIndexes: string[]; droppedCollection: boolean }> {
  const db = handle(connection);
  const collections = scopedCollections();

  let left = 0;
  for (const name of collections) left += await db.collection(name).countDocuments(uncopied);
  if (left) throw new Error(`${left} document(s) still carry only the old field: run the copy again first. Nothing was changed.`);
  const legacyRows = await db.collection(LEGACY_COLLECTION).find({}, { projection: { _id: 1 } }).toArray();
  for (const { _id } of legacyRows) {
    if (!(await db.collection(ORGANISATIONS).countDocuments({ _id }, { limit: 1 }))) {
      throw new Error(`Organisation ${String(_id)} has not been copied yet: run the copy again first. Nothing was changed.`);
    }
  }

  const droppedIndexes: string[] = [];
  for (const name of collections) {
    const indexes = await db.collection(name).indexes().catch(() => []);
    for (const index of indexes) {
      if (!(LEGACY_FIELD in index.key) || !index.name) continue;
      if (apply) await db.collection(name).dropIndex(index.name);
      droppedIndexes.push(`${name}.${index.name}`);
    }
  }

  const byCollection: Record<string, number> = {};
  let total = 0;
  for (const name of collections) {
    const collection = db.collection(name);
    const carrying = { [LEGACY_FIELD]: { $exists: true } };
    const count = apply
      ? (await collection.updateMany(carrying, { $unset: { [LEGACY_FIELD]: "" } })).modifiedCount
      : await collection.countDocuments(carrying);
    byCollection[name] = count;
    total += count;
  }

  const exists = (await db.listCollections({ name: LEGACY_COLLECTION }).toArray()).length > 0;
  if (apply && exists) await db.collection(LEGACY_COLLECTION).drop();
  return { total, byCollection, droppedIndexes, droppedCollection: exists };
}
