import { cache } from "react";
import { connectDB } from "./db";
import { Organisation, IOrganisation } from "@/models/organisation";
import { upsertSingleton } from "./singleton";
import { currentLicence, entitlementsFromLicence } from "./licence";

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

export async function nameOrganisation(name: string): Promise<void> {
  await connectDB();
  await upsertSingleton(Organisation, { $set: { name } });
}

// React's cache() only dedupes calls made during a Server Component render — confirmed against
// this app's own Next config (Route Handlers run the handler as a plain function, with no render
// dispatcher active), so every call from here today — Route Handlers only — still pays its own
// query; a future Server Component reading organisation/plan data would share one.
// Kept anyway: it costs nothing where it doesn't apply, and is correct where it does.
export const getOrganisation = cache(async (): Promise<IOrganisation> => {
  await connectDB();
  const stored = await upsertSingleton(Organisation, {
    $setOnInsert: { entitlements: { plan: "free", features: [], source: "none" } },
  });
  // Derived on every read and never written back, so removing the key is all it takes to undo it
  const fromLicence = entitlementsFromLicence(currentLicence());
  return fromLicence ? { _id: stored._id, name: stored.name, entitlements: fromLicence } : stored;
});
