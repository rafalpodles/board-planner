import type { Types } from "mongoose";
import { connectDB } from "./db";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { scoped, type ScopedDb } from "./db-scope";
import { organisationDomain } from "./organisation-host";
import { Organisation } from "@/models/organisation";
import { inOrganisation } from "./organisation-log";

export type ServedOrganisation = { _id: Types.ObjectId; digestHour?: number; timezone?: string };

export async function servedOrganisations({ includeSuspended = false } = {}): Promise<ServedOrganisation[]> {
  await connectDB();
  const single = !organisationDomain();
  const live = includeSuspended ? { deletedAt: null } : { suspendedAt: null, deletedAt: null };
  const rows = await Organisation.find(single ? { _id: DEFAULT_ORGANISATION_ID } : live)
    .select("digestHour timezone")
    .lean<ServedOrganisation[]>();
  return single && rows.length === 0 ? [{ _id: DEFAULT_ORGANISATION_ID }] : rows;
}

// Boot's repairs and seeding include a suspended organisation, which nothing would bring them to on resume
export async function forEachServedOrganisation(
  job: string,
  work: (db: ScopedDb, organisation: ServedOrganisation) => Promise<void>,
  { includeSuspended = false }: { includeSuspended?: boolean } = {}
): Promise<void> {
  for (const organisation of await servedOrganisations({ includeSuspended })) {
    try {
      await inOrganisation(organisation._id, () => work(scoped(organisation._id), organisation));
    } catch (err) {
      console.error(`${job} failed for organisation ${organisation._id.toHexString()}:`, err);
    }
  }
}

