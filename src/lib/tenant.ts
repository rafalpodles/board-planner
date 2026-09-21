import { cache } from "react";
import { connectDB } from "./db";
import { Tenant, ITenant } from "@/models/tenant";

// React's cache() only dedupes calls made during a Server Component render — confirmed against
// this app's own Next config (Route Handlers run the handler as a plain function, with no render
// dispatcher active), so the two current callers, withEntitlement and GET /api/entitlements, each
// still pay their own query; a future Server Component reading tenant/plan data would share one.
// Kept anyway: it costs nothing where it doesn't apply, and is correct where it does.
export const getTenant = cache(async (): Promise<ITenant> => {
  await connectDB();
  return Tenant.findOneAndUpdate(
    {},
    { $setOnInsert: { entitlements: { plan: "free", features: [], source: "none" } } },
    { upsert: true, returnDocument: "after" }
  ) as Promise<ITenant>;
});
