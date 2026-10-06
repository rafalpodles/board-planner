import { connectDB } from "./db";
import { scoped } from "./db-scope";
import { logInstanceAudit } from "./instanceAudit";
import { storedLicence, type LicenceVerdict } from "./licence";
import { logPlatformAudit } from "./platform-route";
import { Organisation } from "@/models/organisation";

const OBJECT_ID = /^[0-9a-f]{24}$/;

export type StoreOutcome =
  | { status: "stored"; plan: string; expiresAt: string }
  | { status: "unchanged" }
  | { status: "unknown_organisation" }
  | { status: "invalid"; verdict: LicenceVerdict | null }
  | { status: "not_newer" }
  | { status: "changed_meanwhile" };

export async function storeOrganisationLicence(organisationId: string, licenceKey: string, keyId: string): Promise<StoreOutcome> {
  if (!OBJECT_ID.test(organisationId)) return { status: "unknown_organisation" };
  await connectDB();
  const organisation = await Organisation.findById(organisationId).lean();
  if (!organisation || organisation.deletedAt || organisation.deletingAt) return { status: "unknown_organisation" };

  const offered = storedLicence(licenceKey, organisationId);
  if (offered?.verdict !== "valid" && offered?.verdict !== "grace") return { status: "invalid", verdict: offered?.verdict ?? null };
  if (organisation.licenceKey === licenceKey) return { status: "unchanged" };

  const current = storedLicence(organisation.licenceKey, organisationId);
  if (current?.payload && Date.parse(current.payload.issuedAt) >= Date.parse(offered.payload.issuedAt)) return { status: "not_newer" };

  const written = await Organisation.updateOne(
    { _id: organisationId, licenceKey: organisation.licenceKey ?? null, deletedAt: null, deletingAt: null },
    { $set: { licenceKey } }
  );
  if (written.matchedCount === 0) return { status: "changed_meanwhile" };

  const detail = `${offered.payload.plan} until ${offered.payload.expiresAt}, issued ${offered.payload.issuedAt} (request key ${keyId})`;
  void logInstanceAudit(scoped(organisationId), { action: "licence_stored", target: offered.payload.customer, detail });
  await logPlatformAudit({ action: "licence_stored", keyId, subject: organisationId, detail: `${offered.payload.customer}: ${detail}` });
  return { status: "stored", plan: offered.payload.plan, expiresAt: offered.payload.expiresAt };
}
