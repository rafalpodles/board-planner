import mongoose from "mongoose";
import "@/models/all";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { UPLOAD_BUCKET } from "./upload-ownership";

export const UNSCOPED_MODELS = ["Organisation", "RateLimit", "PlatformAuditLog"];

export const scopedModelNames = () =>
  mongoose.modelNames().filter((name) => !UNSCOPED_MODELS.includes(name));

export async function backfillOrganisations(
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
      ? (await collection.updateMany({ organisation: null }, { $set: { organisation: DEFAULT_ORGANISATION_ID } })).matchedCount
      : await collection.countDocuments({ organisation: null });
    byCollection[collection.collectionName] = count;
    total += count;
  }

  // GridFS is the driver's: its files carry the organisation in their metadata (BP-668)
  const files = db.collection(`${UPLOAD_BUCKET}.files`);
  const untagged = { "metadata.organisation": null };
  const count = apply
    ? (await files.updateMany(untagged, { $set: { "metadata.organisation": DEFAULT_ORGANISATION_ID } })).matchedCount
    : await files.countDocuments(untagged);
  byCollection[files.collectionName] = count;
  total += count;
  return { total, byCollection };
}

export async function ensureOrganisation(
  connection: mongoose.Connection,
  { apply, name }: { apply: boolean; name: string }
): Promise<"present" | "created" | "re-keyed"> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const organisations = db.collection(mongoose.model("Organisation").collection.name);

  const rows = await organisations.find({}).toArray();
  if (rows.some((row) => DEFAULT_ORGANISATION_ID.equals(row._id))) {
    if (apply) await organisations.updateOne({ _id: DEFAULT_ORGANISATION_ID }, { $set: { name } });
    return "present";
  }
  if (rows.length > 1) throw new Error(`${rows.length} organisation rows and none with the default id: cannot tell which is the organisation`);

  const [legacy] = rows;
  if (apply) {
    const { _id, ...seed } = new (mongoose.model("Organisation"))({ _id: DEFAULT_ORGANISATION_ID }).toObject();
    await organisations.insertOne({ ...seed, ...(legacy ?? {}), _id, name });
    if (legacy) await organisations.deleteOne({ _id: legacy._id });
  }
  return legacy ? "re-keyed" : "created";
}

type IndexKey = Record<string, 1>;

export const RETIRED_GLOBAL_UNIQUES: {
  collection: string;
  name: string;
  twin: IndexKey;
  partial?: Record<string, unknown>;
}[] = [
  { collection: "users", name: "username_1", twin: { username: 1, organisation: 1 } },
  { collection: "users", name: "email_1", twin: { email: 1, organisation: 1 }, partial: { email: { $gt: "" } } },
  { collection: "projects", name: "key_1", twin: { key: 1, organisation: 1 } },
  { collection: "workers", name: "name_1_host_1", twin: { name: 1, host: 1, organisation: 1 } },
  { collection: "identities", name: "issuer_1_subject_1", twin: { issuer: 1, subject: 1, organisation: 1 } },
  { collection: "invitations", name: "email_1", twin: { email: 1, organisation: 1 }, partial: { status: "pending" } },
  { collection: "agentblocks", name: "key_1", twin: { key: 1, organisation: 1 } },
];

export type RetiredIndexOutcome = { collection: string; name: string; state: "absent" | "would drop" | "dropped" };

export async function dropGlobalUniques(
  connection: mongoose.Connection,
  { apply }: { apply: boolean }
): Promise<RetiredIndexOutcome[]> {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const present: { collection: string; name: string }[] = [];
  const outcomes: RetiredIndexOutcome[] = [];
  for (const { collection, name, twin, partial } of RETIRED_GLOBAL_UNIQUES) {
    const indexes = existing.has(collection) ? await db.collection(collection).indexes() : [];
    if (!indexes.some((index) => index.name === name)) {
      outcomes.push({ collection, name, state: "absent" });
      continue;
    }
    const hasTwin = indexes.some(
      (index) =>
        index.unique &&
        JSON.stringify(index.key) === JSON.stringify(twin) &&
        JSON.stringify(index.partialFilterExpression ?? null) === JSON.stringify(partial ?? null)
    );
    if (!hasTwin) {
      throw new Error(`${collection}.${name}: its per-organisation twin ${JSON.stringify(twin)} is not built yet — start the app once so it builds it, then run this again. Nothing was dropped.`);
    }
    present.push({ collection, name });
  }
  for (const { collection, name } of present) {
    if (apply) await db.collection(collection).dropIndex(name);
    outcomes.push({ collection, name, state: apply ? "dropped" : "would drop" });
  }
  return outcomes;
}

