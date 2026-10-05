import { NextResponse } from "next/server";
import { scoped } from "@/lib/db-scope";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { storedLicence } from "@/lib/licence";
import { hostNotFound } from "@/lib/middleware";
import { logPlatformAudit, withPlatformRequest } from "@/lib/platform-route";
import { Organisation } from "@/models/organisation";

const OBJECT_ID = /^[0-9a-f]{24}$/;

export const POST = withPlatformRequest<{ organisationId: string }>(async (_request, { keyId, body, params }) => {
  let licenceKey: unknown;
  try {
    licenceKey = (JSON.parse(new TextDecoder().decode(body)) as { licenceKey?: unknown })?.licenceKey;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof licenceKey !== "string" || !licenceKey.trim()) {
    return NextResponse.json({ error: "licenceKey is required" }, { status: 400 });
  }

  const { organisationId } = params;
  if (!OBJECT_ID.test(organisationId)) return hostNotFound();
  const organisation = await Organisation.findById(organisationId).lean();
  if (!organisation) return hostNotFound();

  const offered = storedLicence(licenceKey, organisationId);
  if (offered?.verdict !== "valid" && offered?.verdict !== "grace") {
    return NextResponse.json({ error: "The licence key does not verify for this organisation", verdict: offered?.verdict }, { status: 422 });
  }
  if (organisation.licenceKey === licenceKey) return NextResponse.json({ stored: false, unchanged: true });

  const current = storedLicence(organisation.licenceKey, organisationId);
  if (current?.payload && Date.parse(current.payload.issuedAt) >= Date.parse(offered.payload.issuedAt)) {
    return NextResponse.json({ error: "A licence issued at the same time or later is already stored" }, { status: 409 });
  }

  const written = await Organisation.updateOne(
    { _id: organisationId, licenceKey: organisation.licenceKey ?? null },
    { $set: { licenceKey } }
  );
  if (written.matchedCount === 0) {
    return NextResponse.json({ error: "The organisation's licence changed meanwhile; send it again" }, { status: 409 });
  }

  const detail = `${offered.payload.plan} until ${offered.payload.expiresAt}, issued ${offered.payload.issuedAt} (request key ${keyId})`;
  void logInstanceAudit(scoped(organisationId), { action: "licence_stored", target: offered.payload.customer, detail });
  await logPlatformAudit({ action: "licence_stored", keyId, subject: organisationId, detail: `${offered.payload.customer}: ${detail}` });
  return NextResponse.json({ stored: true, plan: offered.payload.plan, expiresAt: offered.payload.expiresAt });
});
