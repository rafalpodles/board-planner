import { NextResponse } from "next/server";
import { ENTITLEMENT_GRACE_MS } from "@/lib/entitlements";
import { withAdmin } from "@/lib/middleware";
import { getOrganisation, licenceOf } from "@/lib/organisation";

const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar days, because the page names the UTC date a key is valid through
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export const GET = withAdmin(async (_request, { db }) => {
  const now = Date.now();
  const check = licenceOf(await getOrganisation(db.organisation), now);
  if (!check) return NextResponse.json({ configured: false });
  if (!check.payload) return NextResponse.json({ configured: true, verdict: check.verdict });

  const expiresAt = Date.parse(check.payload.expiresAt);
  const graceEndsAt = expiresAt + ENTITLEMENT_GRACE_MS;
  return NextResponse.json({
    configured: true,
    verdict: check.verdict,
    customer: check.payload.customer,
    plan: check.payload.plan,
    features: check.payload.features,
    issuedAt: check.payload.issuedAt,
    expiresAt: check.payload.expiresAt,
    graceEndsAt: new Date(graceEndsAt).toISOString(),
    daysLeft: utcDay(expiresAt) - utcDay(now),
    keyId: check.payload.keyId,
  });
});
