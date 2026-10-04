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

type Row = Record<string, unknown>;
type Differing = { _id: string; fields: string[] };

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner) && inner.constructor === Object
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  );
}

const differingFields = (legacy: Row, current: Row) =>
  Object.keys(legacy).filter((key) => key !== "_id" && key !== "__v" && canonical(legacy[key]) !== canonical(current[key]));

const isMissingCollection = (error: { code?: number; codeName?: string }) => error?.code === 26 || error?.codeName === "NamespaceNotFound";

export async function copyLegacyField(
  connection: mongoose.Connection,
  { apply, legacyWins = false }: { apply: boolean; legacyWins?: boolean }
): Promise<Report & { organisationRows: number; differing: Differing[] }> {
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
  const differing: Differing[] = [];
  const organisations = db.collection(ORGANISATIONS);
  for (const { _id, ...row } of await db.collection(LEGACY_COLLECTION).find({}).toArray()) {
    const current = await organisations.findOne({ _id });
    if (!current) {
      if (apply) await organisations.updateOne({ _id }, { $setOnInsert: row }, { upsert: true });
      organisationRows += 1;
      continue;
    }
    const fields = differingFields(row, current);
    if (!fields.length) continue;
    if (apply && legacyWins) await organisations.updateOne({ _id }, { $set: Object.fromEntries(fields.map((field) => [field, row[field]])) });
    differing.push({ _id: String(_id), fields });
  }
  return { total, byCollection, organisationRows, differing };
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
  for (const legacy of await db.collection(LEGACY_COLLECTION).find({}).toArray()) {
    const current = await db.collection(ORGANISATIONS).findOne({ _id: legacy._id });
    if (!current) {
      throw new Error(`Organisation ${String(legacy._id)} has not been copied yet: run the copy again first. Nothing was changed.`);
    }
    const fields = differingFields(legacy, current);
    if (fields.length) {
      throw new Error(
        `Organisation ${String(legacy._id)} differs from its old row in ${fields.join(", ")}: reconcile it, or copy again with --legacy-wins. Nothing was changed.`
      );
    }
  }

  const droppedIndexes: string[] = [];
  for (const name of collections) {
    const indexes = await db
      .collection(name)
      .indexes()
      .catch((error) => {
        if (isMissingCollection(error)) return [];
        throw error;
      });
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
