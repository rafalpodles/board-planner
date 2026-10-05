import type { Types } from "mongoose";
import { connectDB } from "./db";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { scoped, type ScopedDb } from "./db-scope";
import { organisationDomain } from "./organisation-host";
import { Organisation } from "@/models/organisation";

export type ServedOrganisation = { _id: Types.ObjectId; digestHour?: number; timezone?: string };

export async function servedOrganisations(): Promise<ServedOrganisation[]> {
  await connectDB();
  const single = !organisationDomain();
  const rows = await Organisation.find(single ? { _id: DEFAULT_ORGANISATION_ID } : {})
    .select("digestHour timezone")
    .lean<ServedOrganisation[]>();
  return single && rows.length === 0 ? [{ _id: DEFAULT_ORGANISATION_ID }] : rows;
}

export async function forEachServedOrganisation(
  job: string,
  work: (db: ScopedDb, organisation: ServedOrganisation) => Promise<void>
): Promise<void> {
  for (const organisation of await servedOrganisations()) {
    try {
      await work(scoped(organisation._id), organisation);
    } catch (err) {
      console.error(`${job} failed for organisation ${organisation._id.toHexString()}:`, err);
    }
  }
}

