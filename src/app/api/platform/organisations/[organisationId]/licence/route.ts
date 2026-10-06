import { NextResponse } from "next/server";
import { hostNotFound } from "@/lib/middleware";
import { storeOrganisationLicence } from "@/lib/organisation-licence";
import { withPlatformRequest } from "@/lib/platform-route";

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

  const outcome = await storeOrganisationLicence(params.organisationId, licenceKey, keyId);
  switch (outcome.status) {
    case "unknown_organisation":
      return hostNotFound();
    case "invalid":
      return NextResponse.json({ error: "The licence key does not verify for this organisation", verdict: outcome.verdict }, { status: 422 });
    case "unchanged":
      return NextResponse.json({ stored: false, unchanged: true });
    case "not_newer":
      return NextResponse.json({ error: "A licence issued at the same time or later is already stored" }, { status: 409 });
    case "changed_meanwhile":
      return NextResponse.json({ error: "The organisation's licence changed meanwhile; send it again" }, { status: 409 });
    case "stored":
      return NextResponse.json({ stored: true, plan: outcome.plan, expiresAt: outcome.expiresAt });
  }
});
