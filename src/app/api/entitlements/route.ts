import { NextResponse } from "next/server";
import { withAuth } from "@/lib/middleware";
import { getOrganisation, organisationIsNamed } from "@/lib/organisation";

// Nothing here is secret — any authenticated user can read the organisation's own plan and features,
// the way the UI needs it to decide what to upsell.
export const GET = withAuth(async (_request, { db }) => {
  const organisation = await getOrganisation(db.organisation);
  return NextResponse.json({
    organisation: organisationIsNamed(organisation) ? organisation.name : null,
    plan: organisation.entitlements.plan,
    features: organisation.entitlements.features,
    expiresAt: organisation.entitlements.expiresAt ?? null,
  });
});
