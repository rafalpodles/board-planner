import { NextResponse } from "next/server";
import { withAuth } from "@/lib/middleware";
import { getTenant } from "@/lib/tenant";

// Nothing here is secret — any authenticated user can read the tenant's own plan and features,
// the way the UI needs it to decide what to upsell.
export const GET = withAuth(async () => {
  const tenant = await getTenant();
  return NextResponse.json({
    plan: tenant.entitlements.plan,
    features: tenant.entitlements.features,
    expiresAt: tenant.entitlements.expiresAt ?? null,
  });
});
