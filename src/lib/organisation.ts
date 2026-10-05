import { cache } from "react";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { Organisation, IOrganisation } from "@/models/organisation";
import { currentLicence, entitlementsFromLicence, storedLicence, type LicenceCheck } from "./licence";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { organisationDomain } from "./organisation-host";

export const ORGANISATION_NAME_MAX = 80;

export function checkOrganisationName(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "organisation must be a string" };
  const name = value.trim();
  if (name.length > ORGANISATION_NAME_MAX) {
    return { ok: false, error: `organisation is at most ${ORGANISATION_NAME_MAX} characters` };
  }
  return { ok: true, value: name || null };
}

const FREE = { plan: "free", features: [], source: "none" } as const;

function ensureDefaultOrganisation(update: Record<string, unknown> = {}) {
  return Organisation.findOneAndUpdate(
    { _id: DEFAULT_ORGANISATION_ID },
    { ...update, $setOnInsert: { entitlements: { ...FREE, features: [] } } },
    { upsert: true, returnDocument: "after" }
  ).lean<IOrganisation>();
}

export async function nameOrganisation(name: string): Promise<void> {
  await connectDB();
  await ensureDefaultOrganisation({ $set: { name } });
}

// React's cache() only dedupes calls made during a Server Component render — confirmed against
// this app's own Next config (Route Handlers run the handler as a plain function, with no render
// dispatcher active), so every call from here today — Route Handlers only — still pays its own
// query; a future Server Component reading organisation/plan data would share one.
// Kept anyway: it costs nothing where it doesn't apply, and is correct where it does.
const readOrganisation = cache(async (id: string): Promise<IOrganisation> => {
  await connectDB();
  const stored = DEFAULT_ORGANISATION_ID.equals(id)
    ? await ensureDefaultOrganisation()
    : await Organisation.findById(id).lean<IOrganisation>();
  const row: IOrganisation = stored ?? { _id: new Types.ObjectId(id), name: "", entitlements: { ...FREE, features: [] } };

  // With organisations on subdomains each one's plan is the key the licence service stored on it,
  // and nothing else: no environment key, and no plan written straight into the row
  if (organisationDomain()) {
    const fromKey = entitlementsFromLicence(licenceOf(row), "service");
    return { ...row, entitlements: fromKey ?? { ...FREE, features: [] } };
  }
  // Derived on every read and never written back, so removing the key is all it takes to undo it
  const fromLicence = entitlementsFromLicence(licenceOf(row));
  return fromLicence ? { ...row, entitlements: fromLicence } : row;
});

export function licenceOf(row: Pick<IOrganisation, "_id" | "licenceKey">, now: number = Date.now()): LicenceCheck | null {
  const id = String(row._id);
  return organisationDomain()
    ? storedLicence(row.licenceKey, id, now)
    : currentLicence(process.env, now);
}

export const getOrganisation = (organisation: Types.ObjectId | string): Promise<IOrganisation> =>
  readOrganisation(String(organisation));
