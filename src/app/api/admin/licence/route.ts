import { NextResponse } from "next/server";
import { ENTITLEMENT_GRACE_MS } from "@/lib/entitlements";
import { currentLicence } from "@/lib/licence";
import { withAdmin } from "@/lib/middleware";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = withAdmin(async () => {
  const now = Date.now();
  const check = currentLicence(process.env, now);
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
    daysLeft: Math.ceil((expiresAt - now) / DAY_MS),
    graceDaysLeft: Math.ceil((graceEndsAt - now) / DAY_MS),
    keyId: check.payload.keyId,
  });
});
