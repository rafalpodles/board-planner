import mongoose, { type Types } from "mongoose";
import { connectDB } from "./db";
import { scoped, SCOPED_MODELS, type ScopedDb } from "./db-scope";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { forgetOrganisationSlugs } from "./organisation-host";
import { scopedModelNames } from "./organisation-migration";
import { dropSecrets } from "./secret-paths";
import { organisationUploads, UPLOAD_BUCKET } from "./upload-ownership";
import { Organisation } from "@/models/organisation";

export const EXPORT_FORMAT = "board-planner-organisation-export";
export const EXPORT_VERSION = 1;
export const TOMBSTONE_DAYS = 30;
// Longer than any request or job admitted before the suspension can still be writing: a PM turn is 300 s
export const SUSPENSION_SETTLE_MS = 10 * 60 * 1000;
const EXPORT_PAGE = 500;

// Live credentials and in-flight sign-ins: an export is data to keep, and these are keys to open things
export const NOT_EXPORTED: Record<string, string> = {
  Session: "a signed-in browser",
  OAuthCode: "a sign-in in flight",
  OAuthToken: "a live access token",
  OAuthConsent: "a consent screen in flight",
  OidcFlow: "a provider sign-in in flight",
  PasswordResetToken: "a reset link",
  EmailChangeToken: "a confirmation link",
  EnrolmentToken: "a machine enrolment code",
  DeviceEnrolment: "a machine enrolment in flight",
  PmOauthState: "a connection in flight",
};

const CREDENTIAL_FIELD = /hash$/i;

export function exportableRow(model: string, document: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "password" && !CREDENTIAL_FIELD.test(key)));
  return dropSecrets(model, kept);
}

function modelOf(db: ScopedDb, name: string) {
  const model = (db as unknown as Record<string, ScopedDb["User"] | undefined>)[name];
  if (!model) throw new Error(`${name} is a scoped model with no entry in SCOPED_MODELS`);
  return model;
}

// A field the schema hides from every read is still the organisation's data, nested ones included
export function hiddenPaths(name: string): string[] {
  const hidden: string[] = [];
  const walk = (schema: mongoose.Schema, prefix: string) =>
    schema.eachPath((path, type) => {
      if (type.options?.select === false) hidden.push(`+${prefix}${path}`);
      const nested = (type as { schema?: mongoose.Schema }).schema;
      if (nested) walk(nested, `${prefix}${path}.`);
    });
  walk((SCOPED_MODELS as Record<string, () => mongoose.Model<unknown>>)[name]().schema, "");
  return hidden;
}

export type LifeCycleRefusal = "not_found" | "default_organisation" | "deleted";
type LifeCycleRow = { _id: Types.ObjectId; slug?: string; suspendedAt?: Date | null };

export async function organisationForLifeCycle(id: string): Promise<{ ok: true; row: LifeCycleRow } | { ok: false; reason: LifeCycleRefusal }> {
  const hex = id.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(hex)) return { ok: false, reason: "not_found" };
  if (hex === DEFAULT_ORGANISATION_ID.toHexString()) return { ok: false, reason: "default_organisation" };
  await connectDB();
  const row = await Organisation.findById(hex).select("slug suspendedAt deletedAt").lean();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.deletedAt) return { ok: false, reason: "deleted" };
  return { ok: true, row };
}

export async function setSuspended(organisation: Types.ObjectId, suspended: boolean, reason = ""): Promise<void> {
  if (suspended) {
    // Suspending again keeps the first time, which is what the delete's settle window counts from
    await Organisation.updateOne({ _id: organisation, suspendedAt: null }, { $set: { suspendedAt: new Date() } });
    await Organisation.updateOne({ _id: organisation }, { $set: { suspendedReason: reason } });
  } else {
    await Organisation.updateOne({ _id: organisation }, { $set: { suspendedAt: null, suspendedReason: "" } });
  }
  forgetOrganisationSlugs();
}

export function settledSince(suspendedAt: Date | null | undefined, now = Date.now()): boolean {
  return !!suspendedAt && now - suspendedAt.getTime() >= SUSPENSION_SETTLE_MS;
}

export async function organisationFootprint(organisation: Types.ObjectId): Promise<Record<string, number>> {
  const db = scoped(organisation);
  const counts: Record<string, number> = {};
  for (const name of scopedModelNames().sort()) counts[name] = await modelOf(db, name).countDocuments({});
  counts[`${UPLOAD_BUCKET}.files`] = (await organisationUploads(db)?.count()) ?? 0;
  return counts;
}

async function purgeOrganisationRows(organisation: Types.ObjectId): Promise<Record<string, number>> {
  const db = scoped(organisation);
  const removed: Record<string, number> = {};
  removed[`${UPLOAD_BUCKET}.files`] = (await organisationUploads(db)?.deleteAll()) ?? 0;
  for (const name of scopedModelNames().sort()) removed[name] = (await modelOf(db, name).deleteMany({})).deletedCount ?? 0;
  return removed;
}

export async function deleteOrganisationData(organisation: Types.ObjectId): Promise<Record<string, number>> {
  const removed = await purgeOrganisationRows(organisation);
  const tombstone = await Organisation.findById(organisation).select("slug").lean();
  await Organisation.replaceOne({ _id: organisation }, { slug: tombstone?.slug, name: "", deletedAt: new Date() });
  forgetOrganisationSlugs();
  return removed;
}

// Purges again before freeing the slug: anything a straggler wrote after the delete goes with it
export async function sweepDeletedOrganisations(now = Date.now()): Promise<number> {
  await connectDB();
  const cutoff = new Date(now - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000);
  const expired = await Organisation.find({ deletedAt: { $ne: null, $lt: cutoff } }).select("_id").lean();
  for (const { _id } of expired) {
    await purgeOrganisationRows(_id);
    await Organisation.deleteOne({ _id, deletedAt: { $ne: null } });
  }
  return expired.length;
}

const line = (value: unknown) => `${mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false })}\n`;

// Paged by _id rather than one long cursor, which the server closes after ten idle minutes of a slow download
export async function* organisationExport(db: ScopedDb): AsyncGenerator<string> {
  const names = scopedModelNames().sort();
  const exported = names.filter((name) => !Object.hasOwn(NOT_EXPORTED, name));
  yield line({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    organisation: db.organisation,
    exportedAt: new Date(),
    collections: [...exported, `${UPLOAD_BUCKET}.files`, `${UPLOAD_BUCKET}.chunks`],
    notExported: NOT_EXPORTED,
  });
  for (const name of exported) {
    const model = modelOf(db, name);
    const hidden = hiddenPaths(name);
    let after: Types.ObjectId | null = null;
    while (true) {
      const page = (await model
        .find(after ? { _id: { $gt: after } } : {})
        .select(hidden.join(" "))
        .sort({ _id: 1 })
        .limit(EXPORT_PAGE)
        .lean()) as unknown as Record<string, unknown>[];
      for (const document of page) yield line({ collection: name, document: exportableRow(name, document) });
      if (page.length < EXPORT_PAGE) break;
      after = page[page.length - 1]._id as Types.ObjectId;
    }
  }
  const uploads = organisationUploads(db);
  if (uploads) for await (const row of uploads.rows()) yield line(row);
}
