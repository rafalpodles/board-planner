import { cache } from "react";
import { Types } from "mongoose";
import { connectDB } from "./db";
import { Organisation, IOrganisation } from "@/models/organisation";
import { currentLicence, entitlementsFromLicence, storedLicence, type LicenceCheck } from "./licence";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { RESERVED_SLUGS, organisationDomain } from "./organisation-host";
import { duplicateKeyField } from "./mongo-errors";
import { latinFold } from "./identifiers";

export { ORGANISATION_NAME_MAX, checkOrganisationName } from "./organisation-name";

export const NAME_UNAVAILABLE = "That name is not available. Try another.";

const asAddress = (name: string) =>
  latinFold(name.normalize("NFKC"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const nameIsReserved = (name: string): boolean => RESERVED_SLUGS.includes(asAddress(name));

export async function nameIsTaken(name: string, except?: Types.ObjectId): Promise<boolean> {
  await connectDB();
  const count = await Organisation.countDocuments({ name, deletedAt: null, ...(except ? { _id: { $ne: except } } : {}) }).collation({
    locale: "en",
    strength: 1,
  });
  return count > 0;
}

// Only where there are other organisations to clash with, or a reserved address to pass for
export async function nameUnavailable(name: string, except: Types.ObjectId): Promise<boolean> {
  if (organisationDomain() === null) return false;
  return nameIsReserved(name) || (await nameIsTaken(name, except));
}

const FREE = { plan: "free", features: [], source: "none" } as const;

async function ensureDefaultOrganisation(update: Record<string, unknown> = {}) {
  const write = () =>
    Organisation.findOneAndUpdate(
      { _id: DEFAULT_ORGANISATION_ID },
      { ...update, $setOnInsert: { entitlements: { ...FREE, features: [] } } },
      { upsert: true, returnDocument: "after" }
    ).lean<IOrganisation>();
  try {
    return await write();
  } catch (err) {
    if (duplicateKeyField(err) !== "_id") throw err;
    return write();
  }
}

export async function nameOrganisation(name: string): Promise<void> {
  await connectDB();
  await ensureDefaultOrganisation({ $set: { name } });
}

export async function renameOrganisation(organisation: Types.ObjectId, name: string): Promise<void> {
  await connectDB();
  if (DEFAULT_ORGANISATION_ID.equals(organisation)) await ensureDefaultOrganisation({ $set: { name } });
  else await Organisation.updateOne({ _id: organisation }, { $set: { name } });
}

export async function recordMemberSync(organisation: Types.ObjectId, members: number): Promise<void> {
  await connectDB();
  await Organisation.updateOne({ _id: organisation }, { $set: { memberSync: { members, at: new Date() } } });
}

// A self-hosted instance whose first run named nothing has no organisation worth naming on screen
export const organisationIsNamed = (row: Pick<IOrganisation, "name">): boolean =>
  organisationDomain() !== null || (!!row.name && row.name !== "default");

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
