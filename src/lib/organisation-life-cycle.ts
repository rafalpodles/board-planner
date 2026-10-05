import mongoose, { type Types } from "mongoose";
import { connectDB } from "./db";
import { scoped, type ScopedDb } from "./db-scope";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { forgetOrganisationSlugs } from "./organisation-host";
import { scopedModelNames } from "./organisation-migration";
import { organisationUploads, UPLOAD_BUCKET } from "./upload-ownership";
import { Organisation } from "@/models/organisation";

export const EXPORT_FORMAT = "board-planner-organisation-export";
export const EXPORT_VERSION = 1;
export const TOMBSTONE_DAYS = 30;

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

function withoutCredentials(document: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "password" && !CREDENTIAL_FIELD.test(key)));
}

function modelOf(db: ScopedDb, name: string) {
  const model = (db as unknown as Record<string, ScopedDb["User"] | undefined>)[name];
  if (!model) throw new Error(`${name} is a scoped model with no entry in SCOPED_MODELS`);
  return model;
}

export type LifeCycleRefusal = "not_found" | "default_organisation" | "deleted";

export async function organisationForLifeCycle(id: string): Promise<{ ok: true; row: { _id: Types.ObjectId; slug?: string; suspendedAt?: Date | null } } | { ok: false; reason: LifeCycleRefusal }> {
  if (!/^[0-9a-f]{24}$/.test(id)) return { ok: false, reason: "not_found" };
  if (id === DEFAULT_ORGANISATION_ID.toHexString()) return { ok: false, reason: "default_organisation" };
  await connectDB();
  const row = await Organisation.findById(id).select("slug suspendedAt deletedAt").lean();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.deletedAt) return { ok: false, reason: "deleted" };
  return { ok: true, row };
}

export async function setSuspended(organisation: Types.ObjectId, suspended: boolean, reason = ""): Promise<void> {
  await Organisation.updateOne(
    { _id: organisation },
    { $set: suspended ? { suspendedAt: new Date(), suspendedReason: reason } : { suspendedAt: null, suspendedReason: "" } }
  );
  forgetOrganisationSlugs();
}

export async function organisationFootprint(organisation: Types.ObjectId): Promise<Record<string, number>> {
  const db = scoped(organisation);
  const counts: Record<string, number> = {};
  for (const name of scopedModelNames().sort()) counts[name] = await modelOf(db, name).countDocuments({});
  counts[`${UPLOAD_BUCKET}.files`] = (await organisationUploads(db)?.count()) ?? 0;
  return counts;
}

export async function deleteOrganisationData(organisation: Types.ObjectId): Promise<Record<string, number>> {
  const db = scoped(organisation);
  const removed: Record<string, number> = {};
  removed[`${UPLOAD_BUCKET}.files`] = (await organisationUploads(db)?.deleteAll()) ?? 0;
  for (const name of scopedModelNames().sort()) removed[name] = (await modelOf(db, name).deleteMany({})).deletedCount ?? 0;
  const tombstone = await Organisation.findById(organisation).select("slug").lean();
  await Organisation.replaceOne({ _id: organisation }, { slug: tombstone?.slug, name: "", deletedAt: new Date() });
  forgetOrganisationSlugs();
  return removed;
}

export async function sweepDeletedOrganisations(now = Date.now()): Promise<number> {
  await connectDB();
  const cutoff = new Date(now - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000);
  return (await Organisation.deleteMany({ deletedAt: { $ne: null, $lt: cutoff } })).deletedCount ?? 0;
}

const line = (value: unknown) => `${mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false })}\n`;

export async function* organisationExport(db: ScopedDb): AsyncGenerator<string> {
  const names = scopedModelNames().sort();
  yield line({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    organisation: db.organisation,
    exportedAt: new Date(),
    collections: [...names.filter((name) => !(name in NOT_EXPORTED)), `${UPLOAD_BUCKET}.files`, `${UPLOAD_BUCKET}.chunks`],
    notExported: NOT_EXPORTED,
  });
  for (const name of names) {
    if (name in NOT_EXPORTED) continue;
    for await (const document of modelOf(db, name).find({}).sort({ _id: 1 }).lean().cursor()) {
      yield line({ collection: name, document: withoutCredentials(document as unknown as Record<string, unknown>) });
    }
  }
  const uploads = organisationUploads(db);
  if (uploads) for await (const row of uploads.rows()) yield line(row);
}
